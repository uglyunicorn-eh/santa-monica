import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { forgetStats } from 'src/api/routes/stats';
import { PartyDO } from 'src/do/PartyDO';
import { ROLLED_BEFORE_COUNTER, STATS_NAME, StatsDO } from 'src/do/StatsDO';
import { app } from 'src/index';

import { denied, request, signIn, testEnv, uniqueEmail } from './helpers';

const ORIGIN = 'https://gnomik.me';
const stats = () => env.STATS.getByName(STATS_NAME);
const count = async () => (await request('GET', '/v1/stats')).body.rolled as number;

const createParty = async (token: string) => (await request('POST', '/v1/parties', { token, body: { name: 'Party' } })).body as { code: string };
const join = (token: string, code: string) => request('POST', '/v1/parties/join', { token, body: { code, name: 'Guest' } });

/** A party with a host and a guest, ready to draw. */
async function readyParty() {
  const host = await signIn(uniqueEmail('host'), 'Host');
  const guest = await signIn(uniqueEmail('guest'), 'Guest');
  const { code } = await createParty(host.token);
  await join(guest.token, code);
  return { host, code };
}

const draw = (token: string, code: string) => request('POST', '/v1/parties/draw', { token, body: { code } });

const watch = (headers: Record<string, string> = { upgrade: 'websocket', origin: ORIGIN }, e = testEnv()) =>
  app.request('/v1/stats/live', { headers }, e);

describe("the Party'o'meter", () => {
  afterEach(forgetStats);

  it('starts from the parties rolled before it existed', async () => {
    expect(await count()).toBeGreaterThanOrEqual(ROLLED_BEFORE_COUNTER);
  });

  it('counts a party once, when it is first drawn, not its repeats or a refused draw', async () => {
    const { host, code } = await readyParty();
    const before = await count();
    expect((await draw(host.token, code)).status).toBe(200);
    // The roll is counted alongside the draw, not before its answer.
    await vi.waitFor(async () => expect(await count()).toBe(before + 1));
    expect((await draw(host.token, code)).status).toBe(200);
    const lonely = await signIn(uniqueEmail('lonely'), 'Lonely');
    expect((await draw(lonely.token, (await createParty(lonely.token)).code)).status).toBe(409);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await count()).toBe(before + 1);
  });

  it('still draws when the counter cannot be reached, leaving that roll uncounted', async () => {
    const { host, code } = await readyParty();
    const before = await count();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runInDurableObject(env.PARTY.getByName(code), async (party: PartyDO) => {
      const real = (party as any).env;
      (party as any).env = { ...real, STATS: { getByName: () => ({ rolled: async () => { throw new Error('down'); } }) } };
      try {
        return await party.close(host.id);
      } finally {
        (party as any).env = real;
      }
    });
    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('Unable to count the roll', { error: 'Error: down' }));
    warn.mockRestore();
    expect(await count()).toBe(before);
  });

  it('keeps the count in memory for a while, and says so to caches', async () => {
    const kept = testEnv({ PUBLIC_CACHE_MS: '60000' });
    const first = await request('GET', '/v1/stats', { env: kept });
    expect(first.headers.get('cache-control')).toBe('public, max-age=10');
    await stats().rolled();
    expect((await request('GET', '/v1/stats', { env: kept })).body.rolled).toBe(first.body.rolled);
    forgetStats();
    expect((await request('GET', '/v1/stats', { env: kept })).body.rolled).toBe(first.body.rolled + 1);
  });

  it('sends the count on connect and after every roll, answers pings without waking, and ignores the rest', async () => {
    const res = await watch();
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const got: { rolled: number }[] = [];
    ws.addEventListener('message', event => {
      if (event.data !== 'pong') {
        got.push(JSON.parse(String(event.data)));
      }
    });
    await vi.waitFor(() => expect(got).toHaveLength(1));
    const { host, code } = await readyParty();
    await draw(host.token, code);
    await vi.waitFor(() => expect(got).toHaveLength(2));
    expect(got[1]).toEqual({ type: 'stats', rolled: got[0].rolled + 1 });
    ws.send('hello');
    ws.send('ping');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(got).toHaveLength(2);
    ws.close();
  });

  it('refuses anything but an upgrade from the app, a client opening too many, and an object that answers no socket', async () => {
    expect((await watch({ origin: ORIGIN })).status).toBe(400);
    expect((await watch({ upgrade: 'websocket', origin: 'https://evil.example' })).status).toBe(403);
    expect((await watch({ upgrade: 'websocket', origin: ORIGIN }, testEnv({ STATS_WATCH_RATE_LIMIT_IP: denied }))).status).toBe(429);
    const noSocket = { getByName: () => ({ fetch: async () => new Response(null, { status: 426 }) }) } as any;
    expect((await watch({ upgrade: 'websocket', origin: ORIGIN }, testEnv({ STATS: noSocket }))).status).toBe(503);
    // The object itself refuses a plain request.
    expect((await stats().fetch('https://stats/live')).status).toBe(426);
  });

  it('skips viewers whose socket is already closing', async () => {
    await runInDurableObject(stats(), async (instance: StatsDO, state) => {
      const broken = { send: () => { throw new Error('closed'); } } as unknown as WebSocket;
      const getWebSockets = vi.spyOn(state, 'getWebSockets').mockReturnValue([broken]);
      const before = instance.count();
      expect(instance.rolled()).toBe(before + 1);
      getWebSockets.mockRestore();
    });
  });
});
