import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { app } from 'src/index';
import { RESTORE_WINDOW_MS } from 'src/do/PartyDO';
import { jwt, request, signIn, testEnv } from './helpers';

const ORIGIN = 'https://gnomik.me';

const createParty = async (token: string, name = 'Party') =>
  (await request('POST', '/v1/parties', { token, body: { name } })).body as { code: string };
const join = (token: string, code: string, name = 'Guest') => request('POST', '/v1/parties/join', { token, body: { code, name } });
const ticketFor = async (token: string) => (await request('POST', '/v1/live/ticket', { token })).body.ticket as string;

/** Opens a party's live-updates socket the way a browser does. */
const watch = (code: string, ticket: string, headers: Record<string, string> = { upgrade: 'websocket', origin: ORIGIN }) =>
  app.request(`/v1/parties/live?code=${code}&ticket=${encodeURIComponent(ticket)}`, { headers }, testEnv());

/** An accepted socket, with what it received so far and how it was closed. */
async function watcher(code: string, token: string) {
  const res = await watch(code, await ticketFor(token));
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const got: string[] = [];
  const closed: { code?: number } = {};
  ws.addEventListener('message', event => got.push(String(event.data)));
  ws.addEventListener('close', event => { closed.code = event.code; });
  return { ws, got, closed };
}

/** Lets queued socket events arrive. */
const settle = () => new Promise(resolve => setTimeout(resolve, 50));
const CHANGED = JSON.stringify({ type: 'party.changed' });

describe('POST /v1/live/ticket', () => {
  it('trades a session for a ticket, and refuses without one', async () => {
    const who = await signIn();
    expect(await request('POST', '/v1/live/ticket', { token: who.token })).toMatchObject({ status: 200, body: { ticket: expect.any(String) } });
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
    const ticket = await ticketFor(host.token);
    expect((await watch(code, ticket, { origin: ORIGIN })).status).toBe(400);
    expect((await watch(code, ticket, { upgrade: 'websocket', origin: 'https://evil.example' })).status).toBe(403);
    expect((await watch(code, ticket, { upgrade: 'websocket' })).status).toBe(403);
    expect((await watch(code, 'garbage')).status).toBe(401);
    expect((await watch(code, host.token)).status).toBe(401);
    const expired = await jwt().issueToken('LiveTicket', { sub: host.nodeId, email: host.email }, { ttl: -10 });
    expect((await watch(code, expired)).status).toBe(401);
    expect(await watch(code, await ticketFor(stranger.token))).toMatchObject({ status: 403 });
    expect((await watch('ZZZZZZZY', ticket)).status).toBe(403);
    expect((await watch('nope', ticket)).status).toBe(404);
    // The Durable Object refuses a plain request too.
    expect((await env.PARTY.getByName(code).fetch('https://party/live', { headers: { 'x-live-user': host.id } })).status).toBe(403);
  });

  it('tells members about joins and the roll, answers pings without waking, and ignores what watchers send', async () => {
    const host = await signIn();
    const guest = await signIn();
    const { code } = await createParty(host.token);
    const hosts = await watcher(code, host.token);
    expect((await join(guest.token, code)).status).toBe(200);
    await settle();
    expect(hosts.got).toEqual([CHANGED]);

    const guests = await watcher(code, guest.token);
    guests.ws.send('hello');
    guests.ws.send('ping');
    expect((await request('POST', '/v1/parties/draw', { token: host.token, body: { code } })).status).toBe(200);
    await settle();
    expect(hosts.got).toEqual([CHANGED, CHANGED]);
    expect(guests.got).toEqual(['pong', CHANGED]);
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
    await settle();
    expect(guests.closed.code).toBe(4403);
    expect(hosts.got).toEqual([CHANGED]);

    expect((await request('POST', '/v1/parties/delete', { token: host.token, body: { code } })).status).toBe(200);
    await settle();
    expect(others.closed.code).toBe(4410);
    expect(hosts.closed.code).toBeUndefined();
    expect(hosts.got).toEqual([CHANGED, CHANGED]);

    // A refused change tells no one; the host can still watch the deleted party, and sees it restored.
    expect((await request('POST', '/v1/parties/delete', { token: other.token, body: { code } })).status).toBe(404);
    const again = await watcher(code, host.token);
    expect((await request('POST', '/v1/parties/restore', { token: host.token, body: { code } })).status).toBe(200);
    await settle();
    expect(again.got).toEqual([CHANGED]);
    expect(hosts.got).toEqual([CHANGED, CHANGED, CHANGED]);
  });

  it('ends everyone\'s updates when the party is erased after its restore window', async () => {
    const host = await signIn();
    const { code } = await createParty(host.token);
    await request('POST', '/v1/parties/delete', { token: host.token, body: { code } });
    const hosts = await watcher(code, host.token);
    await runInDurableObject(env.PARTY.getByName(code), async (_instance, state) => {
      state.storage.sql.exec('UPDATE party SET deleted_at = ?', Date.now() - RESTORE_WINDOW_MS - 1000);
    });
    await runDurableObjectAlarm(env.PARTY.getByName(code));
    await settle();
    expect(hosts.closed.code).toBe(4410);
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
    await settle();
    expect(guests.closed.code).toBe(4403);
    expect(hosts.got).toEqual([CHANGED]);

    expect(await stub.forgetMember('nobody', 'nobody@example.com')).toBe('none');
    expect(await stub.forgetMember(host.id, host.email)).toBe('deleted');
    await settle();
    expect(hosts.closed.code).toBe(4410);
    expect(hosts.got).toEqual([CHANGED]);
  });

  it('copes with a socket that closed already when telling or ending', async () => {
    const host = await signIn();
    const guest = await signIn();
    const { code } = await createParty(host.token);
    const hosts = await watcher(code, host.token);
    hosts.ws.close(1000, 'bye');
    await settle();
    expect((await join(guest.token, code)).status).toBe(200);
    expect((await request('POST', '/v1/parties/delete', { token: host.token, body: { code } })).status).toBe(200);
  });
});
