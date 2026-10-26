import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { app } from 'src/index';
import { REVEAL_REMINDER_MS, UserDO } from 'src/do/UserDO';
import { jwt, request, signIn, testEnv } from './helpers';

const ORIGIN = 'https://gnomik.me';

const createParty = async (token: string, name = 'Party') =>
  (await request('POST', '/v1/parties', { token, body: { name } })).body as { code: string };
const join = (token: string, code: string, name = 'Guest') => request('POST', '/v1/parties/join', { token, body: { code, name } });
const draw = (token: string, code: string) => request('POST', '/v1/parties/draw', { token, body: { code } });
const unrevealed = async (token: string) => (await request('GET', '/v1/me/parties/unrevealed', { token })).body.items as { code: string; name: string }[];
const reveal = (token: string, code: string) => request('POST', '/v1/me/parties/revealed', { token, body: { code } });

/** Delivers the party's queued updates to its members (the alarm would). */
const settle = async (code: string) => {
  for (let i = 0; i < 20 && await env.PARTY.getByName(code).pendingOutbox(); i++) {
    await runDurableObjectAlarm(env.PARTY.getByName(code));
  }
  await new Promise(resolve => setTimeout(resolve, 50));
};

/** A rolled party with a host and a guest. */
async function rolled(name = 'Rolled') {
  const host = await signIn();
  const guest = await signIn();
  const { code } = await createParty(host.token, name);
  await join(guest.token, code);
  expect((await draw(host.token, code)).status).toBe(200);
  await settle(code);
  return { host, guest, code };
}

describe('GET /v1/me/parties/unrevealed and POST /v1/me/parties/revealed', () => {
  it('lists rolled parties until the name is revealed, for host and guests alike', async () => {
    const { host, guest, code } = await rolled('Office');
    expect(await unrevealed(guest.token)).toEqual([{ code, name: 'Office', closedAt: expect.any(String) }]);
    expect((await unrevealed(host.token)).map(p => p.code)).toEqual([code]);
    expect(await reveal(guest.token, code)).toMatchObject({ status: 200, body: { ok: true } });
    expect(await reveal(guest.token, code)).toMatchObject({ status: 200 });
    expect(await unrevealed(guest.token)).toEqual([]);
    expect((await unrevealed(host.token)).map(p => p.code)).toEqual([code]);
  });

  it('refuses revealing in an open party or someone else\'s, and needs a session', async () => {
    const host = await signIn();
    const stranger = await signIn();
    const { code } = await createParty(host.token);
    expect(await reveal(host.token, code)).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    const done = await rolled();
    expect((await reveal(stranger.token, done.code)).status).toBe(404);
    expect((await request('GET', '/v1/me/parties/unrevealed')).status).toBe(401);
    await env.USER.getByName(stranger.email).tombstone();
    expect((await request('GET', '/v1/me/parties/unrevealed', { token: stranger.token })).status).toBe(401);
    expect((await reveal(stranger.token, done.code)).status).toBe(401);
  });

  it('leaves out parties rolled more than a month ago, deleted ones, and ones rolled before reveals were recorded', async () => {
    const { guest, code } = await rolled();
    const stub = env.USER.getByName(guest.email);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec('UPDATE parties SET closed_at = ?', Date.now() - REVEAL_REMINDER_MS - 1000);
    });
    expect(await unrevealed(guest.token)).toEqual([]);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec('UPDATE parties SET closed_at = ?, deleted_at = ?', Date.now(), Date.now());
    });
    expect(await unrevealed(guest.token)).toEqual([]);
    // An object from before reveals: adding the column marks every rolled party revealed.
    await runInDurableObject(stub, async (instance: UserDO, state) => {
      state.storage.sql.exec('UPDATE parties SET deleted_at = NULL');
      state.storage.sql.exec('ALTER TABLE parties DROP COLUMN revealed_at');
      new (instance.constructor as new (ctx: DurableObjectState, e: typeof env) => UserDO)(state, env);
      // The constructor migrates in blockConcurrencyWhile.
      await vi.waitFor(() => expect(state.storage.sql.exec('SELECT revealed_at FROM parties WHERE slug = ?', code).one().revealed_at).toBe(0));
    });
    expect(await unrevealed(guest.token)).toEqual([]);
  });

  it('keeps a reveal when the party is synced again, and counts rolled parties as revealed on a moved account', async () => {
    const { host, guest, code } = await rolled();
    await reveal(guest.token, code);
    await join(guest.token, code); // syncs the guest's list again
    await settle(code);
    expect(await unrevealed(guest.token)).toEqual([]);

    const moved = env.USER.getByName(`moved-${crypto.randomUUID()}@example.com`);
    const user = (await env.USER.getByName(host.email).get())!;
    const [party] = (await env.USER.getByName(host.email).listParties(5))!;
    await moved.receive({ ...user, email: 'moved@example.com' }, [{ ...party, isHost: true, isProtected: false, isClosed: true, deletedAt: null }]);
    expect(await moved.unrevealed({ userId: user.id, tokenVersion: user.tokenVersion })).toEqual([]);
  });
});

describe('GET /v1/me/live', () => {
  const ticketFor = async (token: string) => (await request('POST', '/v1/live/ticket', { token })).body.ticket as string;
  const watch = (ticket: string) => app.request(`/v1/me/live?ticket=${encodeURIComponent(ticket)}`, { headers: { upgrade: 'websocket', origin: ORIGIN } }, testEnv());

  async function watcher(token: string) {
    const res = await watch(await ticketFor(token));
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const got: unknown[] = [];
    const closed: { code?: number } = {};
    ws.addEventListener('message', event => got.push(String(event.data) === 'pong' ? 'pong' : JSON.parse(String(event.data))));
    ws.addEventListener('close', event => { closed.code = event.code; });
    return { ws, got, closed };
  }

  it('tells the user a party of theirs rolled, and that they revealed it (in another tab)', async () => {
    const host = await signIn();
    const guest = await signIn();
    const { code } = await createParty(host.token, 'Live one');
    await join(guest.token, code);
    const guests = await watcher(guest.token);
    guests.ws.send('hi');
    guests.ws.send('ping');
    await draw(host.token, code);
    await settle(code);
    await reveal(guest.token, code);
    await vi.waitFor(() => {
      expect(guests.got).toEqual(['pong', { type: 'party.rolled', code, name: 'Live one' }, { type: 'party.revealed', code }]);
    });
  });

  it('ends the updates when the user signs out everywhere, cancels an email change, or deletes the account', async () => {
    const a = await signIn();
    const as = await watcher(a.token);
    expect((await request('POST', '/v1/me/sign-out', { token: a.token })).status).toBe(200);
    await vi.waitFor(() => {
      expect(as.closed.code).toBe(4401);
    });

    const b = await signIn();
    const bs = await watcher(b.token);
    expect(await env.USER.getByName(b.email).cancelAccountChange(b.id, crypto.randomUUID(), Date.now() + 60_000)).toBe('cancelled');
    await vi.waitFor(() => {
      expect(bs.closed.code).toBe(4401);
    });

    const c = await signIn();
    const cs = await watcher(c.token);
    cs.ws.close(1000);
    await new Promise(resolve => setTimeout(resolve, 20));
    await env.USER.getByName(c.email).tombstone(); // nothing left to tell or end
  });

  it('refuses a ticket from before the user signed out everywhere, and one for an account that is gone', async () => {
    const who = await signIn();
    const ticket = await ticketFor(who.token);
    await runInDurableObject(env.USER.getByName(who.email), async (_instance, state) => {
      state.storage.sql.exec('UPDATE user SET token_version = token_version + 1');
    });
    expect(await watch(ticket)).toMatchObject({ status: 401 });
    const versionless = await jwt().issueToken('LiveTicket', { sub: who.nodeId, email: who.email }, { ttl: 60 });
    expect((await watch(versionless)).status).toBe(101);
    await env.USER.getByName(who.email).tombstone();
    expect((await watch(versionless)).status).toBe(401);
    expect((await env.USER.getByName(who.email).fetch('https://user/live', { headers: { 'x-live-user': who.id } })).status).toBe(403);
  });
});
