import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from 'src/api/errors';
import { ALL_MAIL, REFUSALS, RETRY_AFTER_S, admitEmail, takeAllMail } from 'src/api/rateLimit';
import { mailRef } from 'src/utils/logRef';
import { MAX_REMEMBERED_REQUESTS, REQUEST_MEMO_MS, forgetRequest, forgetRequests, rememberRequest, seenRequest } from 'src/api/requestMemo';
import { PUBLIC_CACHE_MS, PUBLIC_VIEW_MS, MAX_CACHED_VIEWS, cacheTtl, cachedView, cachedViewCount, clearViews, forgetView, keepView, viewTtl } from 'src/api/viewCache';
import { PartyDO } from 'src/do/PartyDO';
import { MAX_ATTEMPTS } from 'src/do/outbox';
import { PartyView } from 'src/do/types';

import { allowed, denied, drainOutbox, jwt, request, signIn, testEnv, uniqueEmail } from './helpers';

const view = (name: string) => ({ name } as unknown as PartyView);

describe('signed-out view cache', () => {
  afterEach(clearViews);

  it('keeps a view until its time is up', () => {
    keepView('a', view('A'), 1000, 0);
    expect(cachedView('a', 999)?.name).toBe('A');
    expect(cachedView('a', 1000)).toBeUndefined();
    expect(cachedViewCount()).toBe(0);
    expect(cachedView('missing')).toBeUndefined();
  });

  it('keeps nothing when turned off, and drops the oldest view when full', () => {
    keepView('off', view('Off'), 0);
    expect(cachedViewCount()).toBe(0);
    for (let i = 0; i < MAX_CACHED_VIEWS; i++) {
      keepView(`p${i}`, view(`P${i}`), 1000);
    }
    keepView('p0', view('P0 again'), 1000); // a refresh moves it to the end
    keepView('new', view('New'), 1000);
    expect(cachedViewCount()).toBe(MAX_CACHED_VIEWS);
    expect(cachedView('p1')).toBeUndefined();
    expect(cachedView('p0')?.name).toBe('P0 again');
    expect(cachedView('new')?.name).toBe('New');
  });

  it('reads its time from the environment: 3 s for views and 10 s for the stats by default', () => {
    expect(cacheTtl({ ...env, PUBLIC_CACHE_MS: undefined })).toBe(PUBLIC_CACHE_MS);
    expect(viewTtl({ ...env, PUBLIC_CACHE_MS: undefined })).toBe(PUBLIC_VIEW_MS);
    expect(cacheTtl({ ...env, PUBLIC_CACHE_MS: '2500' })).toBe(2500);
    expect(viewTtl({ ...env, PUBLIC_CACHE_MS: '2500' })).toBe(2500);
    expect(cacheTtl({ ...env, PUBLIC_CACHE_MS: 'off' })).toBe(0);
  });

  it('keeps nothing from a lookup that started before the party was written', () => {
    forgetView('raced', 1000);
    keepView('raced', view('Old'), 1000, 1001, 999); // started before the write, finished after it
    expect(cachedView('raced', 1002)).toBeUndefined();
    keepView('raced', view('New'), 1000, 1002, 1001); // started after it
    expect(cachedView('raced', 1003)?.name).toBe('New');
    // The record of writes is capped like the views.
    for (let i = 0; i < MAX_CACHED_VIEWS; i++) {
      forgetView(`w${i}`, 2000);
    }
    keepView('raced', view('Again'), 1000, 2001, 1500);
    expect(cachedView('raced', 2002)?.name).toBe('Again');
  });

  it('forgets one party\'s view', () => {
    keepView('a', view('A'), 1000);
    keepView('b', view('B'), 1000);
    forgetView('a');
    forgetView('missing');
    expect(cachedView('a')).toBeUndefined();
    expect(cachedView('b')?.name).toBe('B');
  });

  it('serves signed-out lookups only, and never a party that does not exist', async () => {
    const cached = testEnv({ PUBLIC_CACHE_MS: '60000' });
    const host = await signIn(uniqueEmail('host'), 'Host');
    const { body: party } = await request('POST', '/v1/parties', { token: host.token, body: { name: 'Before' } });
    const lookUp = (token?: string) => request('POST', '/v1/parties/lookup', { body: { code: party.code }, token, env: cached });
    expect((await lookUp()).body).toMatchObject({ name: 'Before', isJoined: false, isClosed: false });
    // Changed elsewhere (another isolate): signed out, the kept view, for as long as it's kept. The host: as it is.
    const guest = await signIn(uniqueEmail('guest'), 'Guest');
    await env.PARTY.getByName(party.code).join(guest.member, 'Guest', null);
    await env.PARTY.getByName(party.code).close(host.id);
    expect((await lookUp()).body).toMatchObject({ isClosed: false });
    expect((await lookUp(host.token)).body).toMatchObject({ isHost: true, isClosed: true });
    expect((await request('POST', '/v1/parties/lookup', { body: { code: 'QQQQQQQQ' }, env: cached })).status).toBe(404);
    expect(cachedViewCount()).toBe(1);
  });

  it('forgets a party\'s view after a write through this isolate, whatever the write answers', async () => {
    const cached = testEnv({ PUBLIC_CACHE_MS: '60000' });
    const host = await signIn(uniqueEmail('host'), 'Host');
    const guest = await signIn(uniqueEmail('guest'), 'Guest');
    const { body: party } = await request('POST', '/v1/parties', { token: host.token, body: { name: 'Changing' } });
    const lookUp = () => request('POST', '/v1/parties/lookup', { body: { code: party.code }, env: cached });
    const write = (path: string, token: string, extra: object = {}) => request('POST', `/v1/parties/${path}`, { token, body: { code: party.code, ...extra }, env: cached });
    await lookUp();
    expect((await write('join', guest.token, { name: 'Guest' })).status).toBe(200);
    expect(cachedViewCount()).toBe(0);
    await lookUp();
    expect((await write('draw', host.token)).status).toBe(200);
    expect((await lookUp()).body).toMatchObject({ isClosed: true });
    // A refused write forgets it too.
    expect((await write('delete', host.token)).status).toBe(409);
    expect(cachedViewCount()).toBe(0);

    const other = await signIn(uniqueEmail('other'), 'Other');
    const { body: open } = await request('POST', '/v1/parties', { token: other.token, body: { name: 'Going' } });
    const lookUpOpen = () => request('POST', '/v1/parties/lookup', { body: { code: open.code }, env: cached });
    await lookUpOpen();
    await request('POST', '/v1/parties/delete', { token: other.token, body: { code: open.code }, env: cached });
    expect((await lookUpOpen()).status).toBe(404);
  });

  it('forgets the parties an account deletion erases', async () => {
    const cached = testEnv({ PUBLIC_CACHE_MS: '60000' });
    const host = await signIn(uniqueEmail('leaving'), 'Leaving');
    const { body: party } = await request('POST', '/v1/parties', { token: host.token, body: { name: 'Erased' } });
    expect((await request('POST', '/v1/parties/lookup', { body: { code: party.code }, env: cached })).status).toBe(200);
    const link = await jwt().issueToken('AccountDeletion', { sub: host.nodeId, email: host.email, jti: crypto.randomUUID(), ver: host.tokenVersion }, { ttl: 60 });
    expect((await request('POST', '/v1/me/deletion/confirm', { body: { token: link }, env: cached })).status).toBe(200);
    expect((await request('POST', '/v1/parties/lookup', { body: { code: party.code }, env: cached })).status).toBe(404);
  });
});

describe('POST /v1/parties/lookup', () => {
  it('takes the code in any case, and refuses a malformed code like other party writes', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const { body: party } = await request('POST', '/v1/parties', { token: host.token, body: { name: 'Lookup' } });
    const byBody = await request('POST', '/v1/parties/lookup', { token: host.token, body: { code: party.code.toLowerCase() } });
    expect(byBody).toMatchObject({ status: 200, body: { code: party.code, isHost: true } });
    expect(await request('POST', '/v1/parties/lookup', { body: { code: '1' } })).toMatchObject({ status: 400, body: { error: { code: 'invalid', field: 'code' } } });
    expect(await request('POST', '/v1/parties/lookup', { body: { code: party.code }, env: testEnv({ PARTY_LOOKUP_RATE_LIMIT_IP: denied }) }))
      .toMatchObject({ status: 429 });
  });
});

describe('the limit on all emails together', () => {
  const counting = (keys: string[], success = true) => ({ limit: async ({ key }: { key: string }) => { keys.push(key); return { success }; } }) as unknown as RateLimit;

  it('is not part of the per-IP and per-address limits, which are counted in turn', async () => {
    const keys: string[] = [];
    const address: string[] = [];
    const refused = (e: typeof env) => admitEmail(e, '1.2.3.4', 'a@example.com', REFUSALS.signInLinks).then(() => 'ok', (error: ApiError) => error.code);
    // Refused per IP: the address isn't counted, so the address keeps its emails.
    expect(await refused(testEnv({ ENTER_RATE_LIMIT_IP: denied, MAIL_RATE_LIMIT_ADDRESS: counting(address), MAIL_RATE_LIMIT_ALL: counting(keys) }))).toBe('rate_limited');
    expect(address).toEqual([]);
    expect(await refused(testEnv({ MAIL_RATE_LIMIT_ADDRESS: denied, MAIL_RATE_LIMIT_ALL: counting(keys) }))).toBe('rate_limited');
    expect(await refused(testEnv({ MAIL_RATE_LIMIT_ADDRESS: counting(address), MAIL_RATE_LIMIT_ALL: denied }))).toBe('ok');
    expect(address).toEqual([await mailRef(env, 'a@example.com')]);
    expect(keys).toEqual([]);
    expect(await takeAllMail(testEnv({ MAIL_RATE_LIMIT_ALL: counting(keys) }))).toBe(true);
    expect(await takeAllMail(testEnv({ MAIL_RATE_LIMIT_ALL: denied }))).toBe(false);
    expect(keys).toEqual([ALL_MAIL]);
  });

  it('is taken only for an email about to be sent, and refuses it with 429', async () => {
    const keys: string[] = [];
    // Refused for another reason first: a party code that doesn't exist, or an address over its cap.
    expect((await request('POST', '/v1/auth/magic-link', { body: { email: uniqueEmail(), party: 'QQQQQQQQ' }, env: testEnv({ MAIL_RATE_LIMIT_ALL: counting(keys) }) })).status).toBe(404);
    expect((await request('POST', '/v1/auth/magic-link', { body: { email: uniqueEmail('capped') }, env: testEnv({ MAIL_RATE_LIMIT_ADDRESS: denied, MAIL_RATE_LIMIT_ALL: counting(keys) }) })).status).toBe(429);
    expect(keys).toEqual([]);
    expect((await request('POST', '/v1/auth/magic-link', { body: { email: uniqueEmail() }, env: testEnv({ MAIL_RATE_LIMIT_ALL: counting(keys) }) })).status).toBe(202);
    expect(keys).toEqual([ALL_MAIL]);

    const key = crypto.randomUUID();
    const email = uniqueEmail('over');
    const over = testEnv({ MAIL_RATE_LIMIT_ALL: denied });
    expect(await request('POST', '/v1/auth/magic-link', { body: { email }, key, env: over })).toMatchObject({
      status: 429, body: { error: { code: 'rate_limited', field: 'email' } },
    });
    // The request can be tried again once there's room.
    expect((await request('POST', '/v1/auth/magic-link', { body: { email }, key })).status).toBe(202);
    const who = await signIn(uniqueEmail('account'), 'Account');
    expect((await request('POST', '/v1/me/deletion', { token: who.token, env: over })).status).toBe(429);
  });

  it('holds party invites back until there is room, without counting them against their address again', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const { body: party } = await request('POST', '/v1/parties', { token: host.token, body: { name: 'Invites' } });
    const invited = uniqueEmail('invited');
    // What the invite counted against its address's limit.
    const counted: string[] = [];
    const address = { limit: async ({ key }: { key: string }) => { counted.push(key); return { success: true }; } } as unknown as RateLimit;
    const sent = async () => counted.length;
    const queued = () => runInDurableObject(env.PARTY.getByName(party.code), async (_i, state) => state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox').one().n);
    const runWith = (limit: RateLimit) => runInDurableObject(env.PARTY.getByName(party.code), async (instance: PartyDO) => {
      const original = (instance as any).env;
      (instance as any).env = { ...original, MAIL_RATE_LIMIT_ALL: limit, MAIL_RATE_LIMIT_ADDRESS: address };
      try {
        await (instance as any).runOutbox(() => true, true);
      } finally {
        (instance as any).env = original;
      }
    });
    await drainOutbox(party.code);
    await runInDurableObject(env.PARTY.getByName(party.code), async (_i, state) => {
      state.storage.sql.exec(`INSERT INTO outbox (payload, attempts, next_attempt_at) VALUES (?, 0, 0)`, JSON.stringify({
        kind: 'mail.partyInvite', email: invited, hostName: 'Host', partyName: 'Invites', slug: party.code, isProtected: false,
      }));
    });
    const before = await sent();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await runWith(denied);
    expect([await queued(), await sent()]).toEqual([1, before]);
    // Held back, not failed: no failure is logged.
    expect(info).toHaveBeenCalledWith('Outbox delivery held back, will retry', expect.objectContaining({ kind: 'mail.partyInvite' }));
    expect(warn).not.toHaveBeenCalled();
    // Held back for the last time, it's dropped, and that is logged.
    await runInDurableObject(env.PARTY.getByName(party.code), async (_i, state) => {
      state.storage.sql.exec('UPDATE outbox SET attempts = ?', MAX_ATTEMPTS - 1);
    });
    await runWith(denied);
    expect(await queued()).toBe(0);
    expect(warn).toHaveBeenCalledWith('Dropping a message held back too long', expect.objectContaining({ kind: 'mail.partyInvite' }));
    info.mockRestore();
    warn.mockRestore();

    // Put back, it goes out once there's room.
    await runInDurableObject(env.PARTY.getByName(party.code), async (_i, state) => {
      state.storage.sql.exec(`INSERT INTO outbox (payload, attempts, next_attempt_at) VALUES (?, 0, 0)`, JSON.stringify({
        kind: 'mail.partyInvite', email: invited, hostName: 'Host', partyName: 'Invites', slug: party.code, isProtected: false,
      }));
    });
    await runWith(allowed);
    expect([await queued(), await sent()]).toEqual([0, before + 1]);
  });
});

describe('remembered sign-in requests', () => {
  afterEach(forgetRequests);

  it('are remembered for a while, for the same detail only, and let go when their email fails', () => {
    rememberRequest('k', 'party', 0);
    expect(seenRequest('k', 'party', REQUEST_MEMO_MS - 1)).toBe(true);
    expect(seenRequest('k', 'other', 1)).toBe(false);
    expect(seenRequest('k', 'party', REQUEST_MEMO_MS)).toBe(false);
    expect(seenRequest('k', 'party', 1)).toBe(false); // gone once it expired
    rememberRequest('k', 'party');
    forgetRequest('k', 'other');
    expect(seenRequest('k', 'party')).toBe(true);
    forgetRequest('k', 'party');
    expect(seenRequest('k', 'party')).toBe(false);
  });

  it('drop the oldest when full', () => {
    for (let i = 0; i < MAX_REMEMBERED_REQUESTS; i++) {
      rememberRequest(`r${i}`, '');
    }
    rememberRequest('newest', '');
    expect(seenRequest('r0', '')).toBe(false);
    expect(seenRequest('r1', '')).toBe(true);
    expect(seenRequest('newest', '')).toBe(true);
  });
});

describe('every rate limit', () => {
  it('answers a refusal with 429, the same body shape and Retry-After, readable by the app', async () => {
    const who = await signIn(uniqueEmail('limited'), 'Limited');
    const { body: party } = await request('POST', '/v1/parties', { token: who.token, body: { name: 'Limits' } });
    const refusals: [string, string, string, { body?: unknown; token?: string; headers?: Record<string, string> }][] = [
      ['ENTER_RATE_LIMIT_IP', 'POST', '/v1/auth/magic-link', { body: { email: uniqueEmail() } }],
      ['MAIL_RATE_LIMIT_ADDRESS', 'POST', '/v1/me/deletion', { token: who.token }],
      ['MAIL_RATE_LIMIT_ALL', 'POST', '/v1/auth/magic-link', { body: { email: uniqueEmail() } }],
      ['PARTY_LOOKUP_RATE_LIMIT_IP', 'POST', '/v1/parties/lookup', { body: { code: party.code } }],
      ['LEGACY_CODE_LOOKUP_RATE_LIMIT_IP', 'POST', '/v1/parties/lookup', { body: { code: 'QWERT' } }],
      ['JOIN_RATE_LIMIT_USER', 'POST', '/v1/parties/join', { token: who.token, body: { code: party.code, name: 'Me' } }],
      ['INVITE_RATE_LIMIT_USER', 'POST', '/v1/parties/invite', { token: who.token, body: { code: party.code, emails: [uniqueEmail()] } }],
      ['STATS_WATCH_RATE_LIMIT_IP', 'GET', '/v1/stats/live', { headers: { upgrade: 'websocket', origin: 'https://gnomik.me' } }],
    ];
    for (const [limit, method, path, options] of refusals) {
      const res = await request(method, path, { ...options, env: testEnv({ [limit]: denied }), headers: { origin: 'https://gnomik.me', ...options.headers } });
      expect([limit, res.status, res.body.error.code, res.headers.get('retry-after')]).toEqual([limit, 429, 'rate_limited', String(RETRY_AFTER_S)]);
      expect(res.headers.get('access-control-expose-headers')).toContain('retry-after');
    }
  });
});
