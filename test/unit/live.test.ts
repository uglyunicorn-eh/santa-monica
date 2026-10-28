import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { app } from 'src/index';
import { RESTORE_WINDOW_MS } from 'src/do/PartyDO';
import { jwt, request, signIn, testEnv } from './helpers';

const ORIGIN = 'https://gnomik.me';

const createParty = async (token: string, name = 'Party') =>
  (await request('POST', '/v1/parties', { token, body: { name } })).body as { code: string };
const join = (token: string, code: string, name = 'Guest') => request('POST', '/v1/parties/join', { token, body: { code, name } });
/** A live-updates ticket: with a party's code, for that party's socket. */
const ticketFor = async (token: string, code?: string) =>
  (await request('POST', '/v1/live/ticket', { token, body: code ? { code } : undefined })).body.ticket as string;

/** Opens a party's live-updates socket the way a browser does: the party comes from the ticket, never the URL. */
const watch = (ticket: string, headers: Record<string, string> = { upgrade: 'websocket', origin: ORIGIN }) =>
  app.request(`/v1/parties/live?ticket=${encodeURIComponent(ticket)}`, { headers }, testEnv());

/** An accepted socket, with what it received so far and how it was closed. */
async function watcher(code: string, token: string) {
  const res = await watch(await ticketFor(token, code));
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const got: string[] = [];
  const closed: { code?: number } = {};
  ws.addEventListener('message', event => got.push(String(event.data)));
  ws.addEventListener('close', event => { closed.code = event.code; });
  return { ws, got, closed };
}

const CHANGED = JSON.stringify({ type: 'party.changed' });

describe('POST /v1/live/ticket', () => {
  it('trades a session for a ticket that works for five minutes, and refuses without one', async () => {
    const who = await signIn();
    expect(await request('POST', '/v1/live/ticket', { token: who.token })).toMatchObject({ status: 200, body: { ticket: expect.any(String) } });
    const { exp, iat } = await jwt().jwtVerify<{ exp: number; iat: number }>(await ticketFor(who.token), 'LiveTicket');
    expect(exp - iat).toBe(5 * 60);
    expect((await request('POST', '/v1/live/ticket')).status).toBe(401);
    await env.USER.getByName(who.email).tombstone();
    expect((await request('POST', '/v1/live/ticket', { token: who.token })).status).toBe(401);
  });
});

describe('GET /v1/parties/live', () => {
  it('refuses anything but an upgrade from the app with a valid ticket, by a member of a party that exists', async () => {
    const host = await signIn();
    const stranger = await signIn();
    const { code } = await createParty(host.token);
    const ticket = await ticketFor(host.token, code);
    expect((await watch(ticket, { origin: ORIGIN })).status).toBe(400);
    expect((await watch(ticket, { upgrade: 'websocket', origin: 'https://evil.example' })).status).toBe(403);
    expect((await watch(ticket, { upgrade: 'websocket' })).status).toBe(403);
    expect((await watch('garbage')).status).toBe(401);
    expect((await watch(host.token)).status).toBe(401);
    const expired = await jwt().issueToken('LiveTicket', { sub: host.nodeId, email: host.email, party: code }, { ttl: -10 });
    expect((await watch(expired)).status).toBe(401);
    expect(await watch(await ticketFor(stranger.token, code))).toMatchObject({ status: 403 });
    expect((await watch(await ticketFor(host.token, 'ZZZZZZZY'))).status).toBe(403);
    // A ticket without a party opens no party's socket; a party's ticket opens no account socket.
    expect((await watch(await ticketFor(host.token))).status).toBe(401);
    expect((await app.request(`/v1/me/live?ticket=${encodeURIComponent(ticket)}`, { headers: { upgrade: 'websocket', origin: ORIGIN } }, testEnv())).status).toBe(401);
    // The code in the ticket is admitted like any lookup.
    expect((await request('POST', '/v1/live/ticket', { token: host.token, body: { code: 'nope' } })).status).toBe(400);
    expect((await request('POST', '/v1/live/ticket', { token: host.token, body: { code }, env: testEnv({ PARTY_LOOKUP_RATE_LIMIT_IP: { limit: async () => ({ success: false }) } as unknown as RateLimit }) })).status).toBe(429);
    // The Durable Object refuses a plain request too.
    expect((await env.PARTY.getByName(code).fetch('https://party/live', { headers: { 'x-live-user': host.id } })).status).toBe(403);
  });

  it('tells members about joins and the roll, answers pings without waking, and ignores what watchers send', async () => {
    const host = await signIn();
    const guest = await signIn();
    const { code } = await createParty(host.token);
    const hosts = await watcher(code, host.token);
    expect((await join(guest.token, code)).status).toBe(200);
    await vi.waitFor(() => {
      expect(hosts.got).toEqual([CHANGED]);
    });

    const guests = await watcher(code, guest.token);
    guests.ws.send('hello');
    guests.ws.send('ping');
    expect((await request('POST', '/v1/parties/draw', { token: host.token, body: { code } })).status).toBe(200);
    await vi.waitFor(() => {
      expect(hosts.got).toEqual([CHANGED, CHANGED]);
      expect(guests.got).toEqual(['pong', CHANGED]);
    });
  });

  it('ends the updates of a member who leaves, and of guests when the host deletes; the host keeps watching', async () => {
    const host = await signIn();
    const guest = await signIn();
    const other = await signIn();
    const { code } = await createParty(host.token);
    await join(guest.token, code);
    await join(other.token, code, 'Other');
    const hosts = await watcher(code, host.token);
    const guests = await watcher(code, guest.token);
    const others = await watcher(code, other.token);

    expect((await request('POST', '/v1/parties/leave', { token: guest.token, body: { code } })).status).toBe(200);
    await vi.waitFor(() => {
      expect(guests.closed.code).toBe(4403);
      expect(hosts.got).toEqual([CHANGED]);
    });

    expect((await request('POST', '/v1/parties/delete', { token: host.token, body: { code } })).status).toBe(200);
    await vi.waitFor(() => {
      expect(others.closed.code).toBe(4410);
      expect(hosts.closed.code).toBeUndefined();
      expect(hosts.got).toEqual([CHANGED, CHANGED]);
    });

    // A refused change tells no one; the host can still watch the deleted party, and sees it restored.
    expect((await request('POST', '/v1/parties/delete', { token: other.token, body: { code } })).status).toBe(404);
    const again = await watcher(code, host.token);
    expect((await request('POST', '/v1/parties/restore', { token: host.token, body: { code } })).status).toBe(200);
    await vi.waitFor(() => {
      expect(again.got).toEqual([CHANGED]);
      expect(hosts.got).toEqual([CHANGED, CHANGED, CHANGED]);
    });
  });

  it('ends everyone\'s updates when the party is erased after its restore window', async () => {
    const host = await signIn();
    const { code } = await createParty(host.token);
    await request('POST', '/v1/parties/delete', { token: host.token, body: { code } });
    const hosts = await watcher(code, host.token);
    await runInDurableObject(env.PARTY.getByName(code), async (_instance, state) => {
      state.storage.sql.exec('UPDATE party SET deleted_at = ?, restorable_until = NULL', Date.now() - RESTORE_WINDOW_MS - 1000);
    });
    await runDurableObjectAlarm(env.PARTY.getByName(code));
    await vi.waitFor(() => {
      expect(hosts.closed.code).toBe(4410);
    });
  });

  it('ends a deleted account\'s updates: the others are told, or all end with a party deleted with it', async () => {
    const host = await signIn();
    const guest = await signIn();
    const { code } = await createParty(host.token);
    await join(guest.token, code);
    const hosts = await watcher(code, host.token);
    const guests = await watcher(code, guest.token);
    const stub = env.PARTY.getByName(code);

    expect(await stub.forgetMember(guest.id, guest.email)).toBe('left');
    await vi.waitFor(() => {
      expect(guests.closed.code).toBe(4403);
      expect(hosts.got).toEqual([CHANGED]);
    });

    expect(await stub.forgetMember('nobody', 'nobody@example.com')).toBe('none');
    expect(await stub.forgetMember(host.id, host.email)).toBe('deleted');
    await vi.waitFor(() => {
      expect(hosts.closed.code).toBe(4410);
      expect(hosts.got).toEqual([CHANGED]);
    });
  });

  it('copes with a socket that closed already when telling or ending', async () => {
    const host = await signIn();
    const guest = await signIn();
    const { code } = await createParty(host.token);
    const hosts = await watcher(code, host.token);
    hosts.ws.close(1000, 'bye');
    await new Promise(resolve => setTimeout(resolve, 50)); // the party may still list it while it closes
    expect((await join(guest.token, code)).status).toBe(200);
    expect((await request('POST', '/v1/parties/delete', { token: host.token, body: { code } })).status).toBe(200);
  });
});
