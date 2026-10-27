import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { PartyDO } from 'src/do/PartyDO';
import { forgetStats } from 'src/api/routes/stats';
import { ROLLED_BEFORE_COUNTER, STATS_NAME } from 'src/do/StatsDO';
import { strToNodeId } from 'src/utils/strings/nodeId';

import { api, call, createParty, drawParty, joinParty, signIn, uniqueEmail, uniqueIp, untilRefused } from './support';

// Plan section 3 (the Party'o'meter) and review fix 4.

const APP = 'https://gnomik.me';

const rolled = async (settings?: object) => (await call('GET', '/v1/stats', { settings })).body.rolled as number;

/** A party with a host and a guest, ready to be drawn. */
async function readyParty() {
  const host = await signIn(uniqueEmail('host'));
  const guest = await signIn(uniqueEmail('guest'));
  const party = await createParty(host);
  await joinParty(guest, party, 'Guest');
  return { host, party };
}

const watch = (headers: Record<string, string>, ip = uniqueIp()) =>
  api('/v1/stats/live', { headers: { 'cf-connecting-ip': ip, ...headers } });

describe("the Party'o'meter", () => {
  it('starts from the parties rolled before it existed, and is public and briefly cacheable', async () => {
    const res = await call('GET', '/v1/stats', { headers: { origin: APP } });
    expect(res.status).toBe(200);
    expect(res.body.rolled).toBeGreaterThanOrEqual(ROLLED_BEFORE_COUNTER);
    expect(res.headers.get('cache-control')).toBe('public, max-age=10');
    expect(res.headers.get('access-control-allow-origin')).toBe(APP);
  });

  it('counts a party once, when it is first drawn: not its repeats, nor a refused draw', async () => {
    const { host, party } = await readyParty();
    const before = await rolled();
    expect((await drawParty(host, party)).status).toBe(200);
    // The count is made alongside the draw, not before its answer.
    await vi.waitFor(async () => expect(await rolled()).toBe(before + 1));
    expect((await drawParty(host, party)).status).toBe(200);
    const lonely = await signIn(uniqueEmail('lonely'));
    expect((await drawParty(lonely, await createParty(lonely))).status).toBe(409);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await rolled()).toBe(before + 1);
  });

  it('keeps the count in the Worker for a few seconds, so most reads reach no object', async () => {
    const kept = { PUBLIC_CACHE_MS: '60000' };
    const first = await rolled(kept);
    const { host, party } = await readyParty();
    await drawParty(host, party);
    await vi.waitFor(async () => expect(await env.STATS.getByName(STATS_NAME).count()).toBeGreaterThan(first));
    expect(await rolled(kept)).toBe(first);
    forgetStats(); // the kept count is shared by the whole Worker
  });

  it('pushes the count to viewers on connect and after every roll, and answers pings', async () => {
    const res = await watch({ upgrade: 'websocket', origin: APP });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const got: unknown[] = [];
    ws.addEventListener('message', event => got.push(event.data === 'pong' ? 'pong' : JSON.parse(String(event.data))));
    await vi.waitFor(() => expect(got).toHaveLength(1));
    const { rolled: start } = got[0] as { rolled: number };
    const { host, party } = await readyParty();
    await drawParty(host, party);
    await vi.waitFor(() => expect(got).toContainEqual({ type: 'stats', rolled: start + 1 }));
    ws.send('ping');
    await vi.waitFor(() => expect(got).toContain('pong'));
    ws.close();
  });

  it('opens a socket only for an upgrade from the app, a few times a minute per client', async () => {
    expect((await watch({ origin: APP })).status).toBe(400);
    expect((await watch({ upgrade: 'websocket', origin: 'https://evil.example' })).status).toBe(403);
    const ip = uniqueIp();
    const answers = await untilRefused(30, () => watch({ upgrade: 'websocket', origin: APP }, ip));
    expect(answers.slice(0, 30).map(res => res.status)).toEqual(Array(30).fill(101));
    expect(answers.at(-1)!.status).toBe(429);
    for (const res of answers.filter(r => r.webSocket)) {
      res.webSocket!.accept();
      res.webSocket!.close();
    }
  });

  it("never holds up or fails a draw: one it can't reach goes uncounted", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const STATS of [
      { getByName: () => ({ rolled: async () => { throw new Error('down'); } }) },
      { getByName: () => ({ rolled: () => new Promise(() => undefined) }) }, // never answers
    ]) {
      const { host, party } = await readyParty();
      const result = await runInDurableObject(env.PARTY.getByName(party.code), async (instance: PartyDO) => {
        const original = (instance as any).env;
        (instance as any).env = { ...original, STATS };
        try {
          return await instance.close(strToNodeId(host.id).id);
        } finally {
          (instance as any).env = original;
        }
      });
      expect(result).toMatchObject({ ok: true, view: { isClosed: true } });
    }
    warn.mockRestore();
  });
});
