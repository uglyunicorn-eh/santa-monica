import { Hono } from 'hono';
import * as v from 'valibot';

import { action } from 'src/api/action';
import { ApiContext, ApiEnv, jwtFor } from 'src/api/context';
import { originAllowed } from 'src/api/cors';
import { fail, notSignedIn } from 'src/api/errors';
import { readQuery, send } from 'src/api/input';
import { liveQuery, liveTicket, tokens } from 'src/api/schemas';
import { requireSession } from 'src/api/session';
import { LiveTicket } from 'src/api/types';
import { nodeIdToStr } from 'src/utils/strings/nodeId';

// Live updates over WebSockets. A browser can't send an Authorization header on a WebSocket, so a signed-in request
// first trades its session for a ticket (POST /v1/live/ticket, valid a minute), and the socket carries the ticket in
// its query string (redacted from logs). The Worker checks the ticket and passes the upgrade to the Durable Object the
// updates come from, with the user's id in LIVE_USER_HEADER; the object decides who may watch, and accepts the socket
// with the hibernation API, so an idle connection costs nothing.
//
// Messages carry no private data: they say something changed, and the client fetches its own view.

/** How long a live-updates ticket works, in seconds: just long enough to open the socket. */
export const LIVE_TICKET_TTL = 60;

/** The user a WebSocket upgrade is for, set by the Worker on the request it passes to a Durable Object. */
export const LIVE_USER_HEADER = 'x-live-user';

/** The token version the ticket was issued at, when it has one (the user's own updates refuse a stale one). */
export const LIVE_VERSION_HEADER = 'x-live-version';

const invalidTicket = () => fail('unauthenticated', 'This live-updates ticket is invalid or has expired.', 'ticket');

export const live = new Hono<ApiEnv>();

/** Trades a session for a live-updates ticket. One call to the user, to check the session wasn't revoked. */
live.post('/ticket', requireSession, action('liveTicket', async c => {
  const session = c.get('session')!;
  const user = await session.verify();
  if (!user) {
    throw notSignedIn();
  }
  const ticket = await jwtFor(c.env).issueToken<LiveTicket>('LiveTicket', {
    sub: nodeIdToStr({ kind: 'User', id: user.id }), email: user.email, ver: user.tokenVersion,
  }, { ttl: LIVE_TICKET_TTL });
  return send(c, liveTicket, { ticket });
}));

/**
 * A live-updates WebSocket request, checked without any Durable Object call: a WebSocket upgrade, from an allowed
 * origin (no other site's page may open one), with a valid ticket. Returns the request to pass on, with the user set.
 */
export async function liveRequest(c: ApiContext): Promise<{ userId: string; email: string; request: Request }> {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    throw fail('invalid', 'Expected a WebSocket upgrade.');
  }
  if (!originAllowed(c.req.header('origin') ?? '', c.env.ALLOWED_ORIGINS)) {
    throw fail('forbidden', 'Live updates are only for the app.');
  }
  const { ticket } = readQuery(c, liveQuery);
  let payload: unknown;
  try {
    payload = await jwtFor(c.env).jwtVerify(ticket, 'LiveTicket');
  } catch {
    payload = undefined;
  }
  const claims = v.safeParse(tokens.liveTicket, payload);
  if (!claims.success) {
    throw invalidTicket();
  }
  const headers = new Headers(c.req.raw.headers);
  headers.set(LIVE_USER_HEADER, claims.output.sub);
  headers.delete(LIVE_VERSION_HEADER);
  if (claims.output.ver !== undefined) {
    headers.set(LIVE_VERSION_HEADER, String(claims.output.ver));
  }
  return { userId: claims.output.sub, email: claims.output.email, request: new Request(c.req.raw.url, { headers }) };
}

/**
 * A Durable Object's answer to an upgrade: the socket, re-made into a response the app's middleware can still set
 * headers on, or `refused` when the object didn't accept it.
 */
export function passUpgrade(answer: Response, refused: () => Error): Response {
  if (!answer.webSocket) {
    throw refused();
  }
  return new Response(null, { status: 101, webSocket: answer.webSocket });
}
