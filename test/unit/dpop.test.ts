import { env, runInDurableObject } from 'cloudflare:test';
import * as jose from 'jose';
import { describe, expect, it } from 'vitest';

import { DPOP_TIME_HEADER, authenticate } from 'src/api/session';
import { UserToken } from 'src/api/types';
import { MAX_JTI_LENGTH, MAX_PROOF_LENGTH, PROOF_MAX_SKEW_S, PublicJwk, checkProof, proofId, proofUrl, thumbprint } from 'src/utils/dpop';

import { jwt, request, signIn, testEnv, uniqueEmail } from './helpers';

const BASE = 'http://localhost';

/** A browser's key pair, and its public key as the app sends it at sign-in. */
async function browserKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey;
  return { pair, jwk: { kty, crv, x, y } as PublicJwk };
}

type Key = Awaited<ReturnType<typeof browserKey>>;

const ath = async (token: string) => jose.base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));

/** A DPoP proof as the app makes one. `claims` and `header` change or drop (undefined) its parts. */
async function proof(key: Key, method: string, url: string, token: string, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const payload = { htm: method, htu: url, iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID(), ath: await ath(token), ...claims };
  for (const [name, value] of Object.entries(payload)) {
    if (value === undefined) {
      delete (payload as Record<string, unknown>)[name];
    }
  }
  return new jose.SignJWT(payload).setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk, ...header }).sign(key.pair.privateKey);
}

/** A session token bound to `key`, for `who`. */
const boundToken = async (who: { nodeId: string; email: string; tokenVersion: number }, key: Key) =>
  jwt().issueToken<UserToken>('UserToken', { sub: who.nodeId, email: who.email, ver: who.tokenVersion, cnf: { jkt: await thumbprint(key.jwk) } }, { ttl: 3600 });

describe('DPoP proofs', () => {
  it('hold for their key, method, URL (any trailing slash) and token, made within a minute', async () => {
    const key = await browserKey();
    const jkt = await thumbprint(key.jwk);
    const req = { method: 'GET', url: `${BASE}/v1/me`, token: 'the.session.token', jkt };
    expect(await checkProof(await proof(key, 'GET', `${BASE}/v1/me/?x=1#y`, req.token), req)).toBe('ok');
    expect(await checkProof(undefined, req)).toBe('missing');
    expect(await checkProof('garbage', req)).toBe('invalid');
    expect(await checkProof('a'.repeat(MAX_PROOF_LENGTH + 1), req)).toBe('invalid');

    const other = await browserKey();
    const refused = [
      await proof(other, 'GET', req.url, req.token), // another key
      await proof(key, 'POST', req.url, req.token), // another method
      await proof(key, 'GET', `${BASE}/v1/me/parties`, req.token), // another URL
      await proof(key, 'GET', 'not a url', req.token),
      await proof(key, 'GET', req.url, 'another.session.token'), // another token
      await proof(key, 'GET', req.url, req.token, { jti: undefined }),
      await proof(key, 'GET', req.url, req.token, { iat: undefined }),
      await proof(key, 'GET', req.url, req.token, { htu: undefined }),
      await proof(key, 'GET', req.url, req.token, {}, { typ: 'JWT' }),
    ];
    for (const p of refused) {
      expect(await checkProof(p, req)).toBe('invalid');
    }
    // No key in the header at all.
    const bare = await new jose.SignJWT({ htm: 'GET' }).setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256' }).sign(key.pair.privateKey);
    expect(await checkProof(bare, req)).toBe('invalid');
  });

  it('say a clock is off rather than refuse, either way', async () => {
    const key = await browserKey();
    const req = { method: 'GET', url: `${BASE}/v1/me`, token: 't.t.t', jkt: await thumbprint(key.jwk) };
    const now = Math.floor(Date.now() / 1000);
    for (const iat of [now - PROOF_MAX_SKEW_S - 5, now + PROOF_MAX_SKEW_S + 5]) {
      expect(await checkProof(await proof(key, 'GET', req.url, req.token, { iat }), req, now)).toBe('skewed');
    }
    expect(await checkProof(await proof(key, 'GET', req.url, req.token, { iat: now - PROOF_MAX_SKEW_S }), req, now)).toBe('ok');
  });

  it('compare URLs by origin and path only', () => {
    expect(proofUrl('https://api.gnomik.me/v1/me/')).toBe('https://api.gnomik.me/v1/me');
    expect(proofUrl('https://api.gnomik.me')).toBe('https://api.gnomik.me/');
    expect(proofUrl('nope')).toBeUndefined();
  });
});

describe('bound sessions', () => {
  it('are issued when sign-in sends a key, and need a proof on every request', async () => {
    const key = await browserKey();
    const email = uniqueEmail('bound');
    const link = await jwt().issueToken('EnterRequest', { email, jti: crypto.randomUUID() }, { ttl: 60 });
    const { status, body } = await request('POST', '/v1/auth/session', { body: { token: link, key: key.jwk } });
    expect(status).toBe(200);
    const token = body.userToken as string;
    expect(await jwt().jwtVerify<UserToken>(token, 'UserToken')).toMatchObject({ cnf: { jkt: await thumbprint(key.jwk) } });

    expect((await request('GET', '/v1/me', { token })).status).toBe(401);
    expect((await request('GET', '/v1/me', { token, headers: { dpop: await proof(key, 'GET', `${BASE}/v1/me`, token) } })).body.email).toBe(email);
    // A proof for another route, or by another key, is no session.
    expect((await request('GET', '/v1/me', { token, headers: { dpop: await proof(key, 'GET', `${BASE}/v1/me/parties`, token) } })).status).toBe(401);
    expect((await request('GET', '/v1/me', { token, headers: { dpop: await proof(await browserKey(), 'GET', `${BASE}/v1/me`, token) } })).status).toBe(401);
    // Without the request to check against, a bound token is no session either.
    expect(await authenticate(env, `Bearer ${token}`)).toBeUndefined();
  });

  it('answer a wrong clock with 400 and the Worker\'s time, never 401, on signed-in and optional routes alike', async () => {
    const key = await browserKey();
    const who = await signIn(uniqueEmail('clock'), 'Clock');
    const token = await boundToken(who, key);
    const late = { iat: Math.floor(Date.now() / 1000) - 600 };
    const res = await request('GET', '/v1/me', { token, headers: { dpop: await proof(key, 'GET', `${BASE}/v1/me`, token, late) } });
    expect(res).toMatchObject({ status: 400, body: { error: { code: 'invalid', field: 'DPoP' } } });
    expect(Math.abs(Number(res.headers.get(DPOP_TIME_HEADER)) - Date.now() / 1000)).toBeLessThan(5);
    const { body: party } = await request('POST', '/v1/parties', { token, body: { name: 'Clock party' }, headers: { dpop: await proof(key, 'POST', `${BASE}/v1/parties`, token) } });
    const lookup = await request('POST', '/v1/parties/lookup', { token, body: { code: party.code }, headers: { dpop: await proof(key, 'POST', `${BASE}/v1/parties/lookup`, token, late) } });
    expect(lookup.status).toBe(400);
  });

  it('see an optional route as signed out when the proof is bad', async () => {
    const key = await browserKey();
    const who = await signIn(uniqueEmail('optional'), 'Host');
    const token = await boundToken(who, key);
    const { body: party } = await request('POST', '/v1/parties', { token, body: { name: 'Mine' }, headers: { dpop: await proof(key, 'POST', `${BASE}/v1/parties`, token) } });
    const lookup = (dpop?: string) => request('POST', '/v1/parties/lookup', { token, body: { code: party.code }, headers: dpop ? { dpop } : {} });
    expect((await lookup()).body).toMatchObject({ isHost: false, isJoined: false });
    expect((await lookup(await proof(key, 'POST', `${BASE}/v1/parties/lookup`, token))).body).toMatchObject({ isHost: true });
  });

  it('bind the new session of an email change too, and refuse a malformed key', async () => {
    const key = await browserKey();
    const who = await signIn(uniqueEmail('mover'), 'Mover');
    const newEmail = uniqueEmail('moved');
    const change = await jwt().issueToken('EmailChange', { sub: who.nodeId, email: who.email, newEmail, jti: crypto.randomUUID(), ver: 0 }, { ttl: 60 });
    const moved = await request('POST', '/v1/me/email-change/confirm', { body: { token: change, key: key.jwk } });
    expect(await jwt().jwtVerify<UserToken>(moved.body.userToken, 'UserToken')).toMatchObject({ cnf: { jkt: await thumbprint(key.jwk) } });

    const link = await jwt().issueToken('EnterRequest', { email: uniqueEmail(), jti: crypto.randomUUID() }, { ttl: 60 });
    for (const bad of [{ ...key.jwk, d: 'secret' }, { ...key.jwk, crv: 'P-384' }, { ...key.jwk, x: 'short' }, 'key']) {
      expect(await request('POST', '/v1/auth/session', { body: { token: link, key: bad } })).toMatchObject({ status: 400, body: { error: { code: 'invalid', field: expect.stringMatching(/^key/) } } });
    }
    expect((await request('POST', '/v1/auth/session', { body: { token: link, key: null } })).status).toBe(200);
  });

  it('are the only ones that count once REQUIRE_BOUND_SESSIONS is on', async () => {
    const strict = testEnv({ REQUIRE_BOUND_SESSIONS: 'true' });
    const key = await browserKey();
    const who = await signIn(uniqueEmail('strict'), 'Strict');
    expect((await request('GET', '/v1/me', { token: who.token, env: strict })).status).toBe(401);
    const token = await boundToken(who, key);
    expect((await request('GET', '/v1/me', { token, env: strict, headers: { dpop: await proof(key, 'GET', `${BASE}/v1/me`, token) } })).status).toBe(200);
  });

  it('let the app send the proof header and read the clock header across origins', async () => {
    const preflight = await (await import('src/index')).app.request('/v1/me', {
      method: 'OPTIONS',
      headers: { origin: 'https://gnomik.me', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,dpop' },
    }, testEnv());
    expect(preflight.headers.get('access-control-allow-headers')).toContain('dpop');
    const actual = await (await import('src/index')).app.request('/v1/stats', { headers: { origin: 'https://gnomik.me' } }, testEnv());
    expect(actual.headers.get('access-control-expose-headers')).toContain('dpop-time');
  });
});

describe('a DPoP proof', () => {
  it('works for one request only on every route that changes something, and is checked but not recorded on reads', async () => {
    const key = await browserKey();
    const who = await signIn(uniqueEmail('replay'), 'Replay');
    const token = await boundToken(who, key);
    const other = await signIn(uniqueEmail('other-host'), 'Other');
    const { body: theirs } = await request('POST', '/v1/parties', { token: other.token, body: { name: 'Theirs' } });
    /** Sends `method path` with a new proof, then again with the very same proof. */
    const twice = async (method: string, path: string, body?: unknown) => {
      const dpop = await proof(key, method, `${BASE}${path}`, token);
      const first = await request(method, path, { token, body, headers: { dpop } });
      const again = await request(method, path, { token, body, headers: { dpop } });
      return { first, again };
    };
    const created = await twice('POST', '/v1/parties', { name: 'Bound party' });
    expect(created.first.status).toBe(201);
    expect(created.again.status).toBe(401);
    const code = created.first.body.code as string;
    // Reads: the same proof works again, to the same URL, and nothing is written for it.
    for (const path of ['/v1/me', '/v1/me/parties', '/v1/me/parties/unrevealed']) {
      const { first, again } = await twice('GET', path);
      expect([path, first.status, again.status]).toEqual([path, 200, 200]);
    }
    const recorded = () => runInDurableObject(env.USER.getByName(who.email), async (_i, state) =>
      state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM used_proofs').one().n);
    const before = await recorded();
    await twice('GET', '/v1/me');
    expect(await recorded()).toBe(before);
    const routes: [string, string, unknown?][] = [
      ['PATCH', '/v1/me', { name: 'Bound' }],
      ['POST', '/v1/live/ticket'],
      ['POST', '/v1/me/deletion'],
      ['POST', '/v1/parties/invite', { code, emails: [uniqueEmail('invited')] }],
      ['POST', '/v1/parties/join', { code: theirs.code, name: 'Bound' }],
      ['POST', '/v1/parties/leave', { code: theirs.code }],
      ['POST', '/v1/parties/delete', { code }],
      ['POST', '/v1/parties/restore', { code }],
      ['POST', '/v1/me/sign-out'],
    ];
    for (const [method, path, body] of routes) {
      const { first, again } = await twice(method, path, body);
      expect([method, path, first.status < 400]).toEqual([method, path, true]);
      expect([method, path, again.status, again.body.error?.code]).toEqual([method, path, 401, 'unauthenticated']);
    }
  });

  it('works again on a lookup, which changes nothing', async () => {
    const key = await browserKey();
    const who = await signIn(uniqueEmail('replay-lookup'), 'Host');
    const token = await boundToken(who, key);
    const { body: party } = await request('POST', '/v1/parties', { token, body: { name: 'Mine' }, headers: { dpop: await proof(key, 'POST', `${BASE}/v1/parties`, token) } });
    const dpop = await proof(key, 'POST', `${BASE}/v1/parties/lookup`, token);
    const lookup = () => request('POST', '/v1/parties/lookup', { token, body: { code: party.code }, headers: { dpop } });
    expect((await lookup()).body).toMatchObject({ isHost: true });
    expect((await lookup()).body).toMatchObject({ isHost: true });
  });

  it('may be checked more than once by the request it came with, and is forgotten once it would be refused anyway', async () => {
    const email = uniqueEmail('proof-store');
    const stub = env.USER.getByName(email);
    const user = await stub.ensure(email);
    const proof = { jti: crypto.randomUUID(), request: crypto.randomUUID(), until: Date.now() + 60_000 };
    const session = { userId: user.id, tokenVersion: user.tokenVersion, proof };
    expect(await stub.check(session)).toMatchObject({ id: user.id });
    expect(await stub.check(session)).toMatchObject({ id: user.id });
    expect(await stub.check({ ...session, proof: { ...proof, request: crypto.randomUUID() } })).toBeNull();
    // A session that doesn't hold claims nothing.
    const unclaimed = { jti: crypto.randomUUID(), request: crypto.randomUUID(), until: Date.now() + 60_000 };
    expect(await stub.check({ userId: user.id, tokenVersion: user.tokenVersion + 1, proof: unclaimed })).toBeNull();
    expect(await stub.check({ ...session, proof: unclaimed })).toMatchObject({ id: user.id });

    const old = { jti: crypto.randomUUID(), request: crypto.randomUUID(), until: Date.now() - 1 };
    await stub.check({ ...session, proof: old });
    await stub.check({ ...session, proof: { jti: crypto.randomUUID(), request: crypto.randomUUID(), until: Date.now() + 60_000 } });
    const kept = await runInDurableObject(stub, async (_i, state) => state.storage.sql.exec<{ jti: string }>('SELECT jti FROM used_proofs').toArray().map(r => r.jti));
    expect(kept).not.toContain(old.jti);
    expect(kept).toContain(proof.jti);
  });

  it('has a short id, and stops being kept once it would be refused anyway', async () => {
    const key = await browserKey();
    const req = { method: 'GET', url: `${BASE}/v1/me`, token: 'token', jkt: await thumbprint(key.jwk) };
    expect(await checkProof(await proof(key, 'GET', req.url, req.token, { jti: 'j'.repeat(MAX_JTI_LENGTH) }), req)).toBe('ok');
    expect(await checkProof(await proof(key, 'GET', req.url, req.token, { jti: 'j'.repeat(MAX_JTI_LENGTH + 1) }), req)).toBe('invalid');
    const iat = 1_800_000_000;
    expect(proofId(await proof(key, 'GET', req.url, req.token, { jti: 'x', iat }))).toEqual({ jti: 'x', until: (iat + PROOF_MAX_SKEW_S) * 1000 });
  });
});
