import { env } from 'cloudflare:test';
import * as jose from 'jose';
import { describe, expect, it } from 'vitest';

import { DPOP_TIME_HEADER } from 'src/api/session';
import { UserToken } from 'src/api/types';
import { thumbprint } from 'src/utils/dpop';
import { nodeIdToStr, strToNodeId } from 'src/utils/strings/nodeId';

import {
  api, browserKey, call, createParty, joinParty, jwt, mailbox, magicLinkToken, mintEnterRequestToken, mintUserToken, proof, redeem,
  requestEmailChange, requestMagicLink, signIn, signInBound, uniqueEmail, uniqueIp,
} from './support';

// Plan sections 4.1 (the party code out of the URL) and 4.3 (bound sessions, DPoP), with review fix 3 (a proof works
// once). Bound people are signed in the way the app does it, and `call` signs each of their requests with a new proof.

const APP = 'https://gnomik.me';

describe('POST /v1/parties/lookup', () => {
  it('shows anyone the limited view, a member more and the host everything, with the code in any case', async () => {
    const host = await signIn(uniqueEmail('host'));
    const guest = await signIn(uniqueEmail('guest'));
    const party = await createParty(host, 'Looked up');
    await joinParty(guest, party, 'Guest');
    const look = async (who?: { token: string }) => (await call('POST', '/v1/parties/lookup', { token: who?.token, body: { code: party.code.toLowerCase() } })).body;
    expect(await look()).toMatchObject({ code: party.code, isJoined: false, participants: null, password: null });
    expect(await look(guest)).toMatchObject({ isJoined: true, isHost: false, participantCount: 2 });
    expect(await look(host)).toMatchObject({ isHost: true, participants: ['Guest', expect.any(String)].sort() });
    // The lookup by query string is gone.
    expect((await call('GET', `/v1/parties?code=${party.code}`)).status).toBe(404);
  });

  it('refuses a malformed code, answers 404 for an unknown one, and is limited per client like other lookups', async () => {
    expect(await call('POST', '/v1/parties/lookup', { body: { code: '1' } })).toMatchObject({ status: 400, body: { error: { code: 'invalid', field: 'code' } } });
    expect((await call('POST', '/v1/parties/lookup', { body: { code: 'QQQQQQQQ' } })).status).toBe(404);
    const ip = uniqueIp();
    for (let i = 0; i < 60; i++) {
      expect((await call('POST', '/v1/parties/lookup', { body: { code: 'QQQQQQQQ' }, ip })).status).toBe(404);
    }
    expect((await call('POST', '/v1/parties/lookup', { body: { code: 'QQQQQQQQ' }, ip })).status).toBe(429);
  });
});

describe('bound sessions', () => {
  it('are issued when sign-in sends a key, and work only with a proof from that key, for that request', async () => {
    const who = await signInBound();
    expect(await jwt().jwtVerify<UserToken>(who.token, 'UserToken')).toMatchObject({ cnf: { jkt: await thumbprint(who.browserKey.jwk) } });
    expect((await call('GET', '/v1/me', { token: who.token })).status).toBe(401);
    expect((await call('GET', '/v1/me', who)).body.email).toBe(who.email);
    expect((await call('GET', '/v1/me/', who)).status).toBe(200); // a trailing slash names the same URL
    const wrong = async (dpop: string) => (await call('GET', '/v1/me', { token: who.token, headers: { dpop } })).status;
    expect(await wrong(await proof(who.browserKey, 'GET', '/v1/me/parties', who.token))).toBe(401); // another URL
    expect(await wrong(await proof(who.browserKey, 'POST', '/v1/me', who.token))).toBe(401); // another method
    expect(await wrong(await proof(await browserKey(), 'GET', '/v1/me', who.token))).toBe(401); // another key
    expect(await wrong(await proof(who.browserKey, 'GET', '/v1/me', 'another-token'))).toBe(401); // another token
    expect(await wrong(await proof(who.browserKey, 'GET', 'https://elsewhere.test/v1/me', who.token))).toBe(401); // another origin
  });

  it('carry a whole party through, every request with its own proof', async () => {
    const host = await signInBound(uniqueEmail('bound-host'));
    const guest = await signInBound(uniqueEmail('bound-guest'));
    const created = await call('POST', '/v1/parties', { ...host, body: { name: 'Bound party' } });
    expect(created.status).toBe(201);
    const code = created.body.code as string;
    expect((await call('POST', '/v1/parties/join', { ...guest, body: { code, name: 'Guest' } })).status).toBe(200);
    expect((await call('POST', '/v1/parties/invite', { ...host, body: { code, emails: [uniqueEmail('invited')] } })).status).toBe(200);
    expect((await call('POST', '/v1/parties/draw', { ...host, body: { code } })).body.isClosed).toBe(true);
    for (const who of [host, guest]) {
      expect((await call('POST', '/v1/parties/lookup', { ...who, body: { code } })).body.target).not.toBeNull();
      expect((await call('GET', '/v1/me/parties', who)).body.items.map((p: { code: string }) => p.code)).toContain(code);
    }
    // A live-updates ticket, and the party's socket with it.
    const { ticket } = (await call('POST', '/v1/live/ticket', { ...guest, body: { code } })).body;
    const socket = await api(`/v1/parties/live?ticket=${ticket}`, { headers: { upgrade: 'websocket', origin: APP } });
    expect(socket.status).toBe(101);
    socket.webSocket!.accept();
    socket.webSocket!.close();
  });

  it("answer a wrong clock with 400 and the Worker's time, readable by the app, on signed-in and optional routes alike", async () => {
    const who = await signInBound();
    const late = { iat: Math.floor(Date.now() / 1000) - 600 };
    const res = await call('GET', '/v1/me', { token: who.token, headers: { origin: APP, dpop: await proof(who.browserKey, 'GET', '/v1/me', who.token, late) } });
    expect(res).toMatchObject({ status: 400, body: { error: { code: 'invalid', field: 'DPoP' } } });
    expect(Math.abs(Number(res.headers.get(DPOP_TIME_HEADER)) - Date.now() / 1000)).toBeLessThan(5);
    expect(res.headers.get('access-control-expose-headers')).toContain('dpop-time');
    const lookup = await call('POST', '/v1/parties/lookup', {
      token: who.token, body: { code: 'QQQQQQQQ' }, headers: { dpop: await proof(who.browserKey, 'POST', '/v1/parties/lookup', who.token, late) },
    });
    expect(lookup.status).toBe(400);
  });

  it('see an optional route as signed out when the proof is missing or bad', async () => {
    const host = await signInBound();
    const party = (await call('POST', '/v1/parties', { ...host, body: { name: 'Mine' } })).body;
    expect((await call('POST', '/v1/parties/lookup', { token: host.token, body: { code: party.code } })).body).toMatchObject({ isHost: false, isJoined: false });
    expect((await call('POST', '/v1/parties/lookup', { ...host, body: { code: party.code } })).body).toMatchObject({ isHost: true });
  });

  it('bind the new session of an email change too, and refuse a malformed key at sign-in', async () => {
    const who = await signIn(uniqueEmail('mover'));
    const link = await requestEmailChange(who, uniqueEmail('moved'));
    const key = await browserKey();
    const moved = await call('POST', '/v1/me/email-change/confirm', { body: { token: link, key: key.jwk } });
    expect(moved.status).toBe(200);
    expect(await jwt().jwtVerify<UserToken>(moved.body.userToken, 'UserToken')).toMatchObject({ cnf: { jkt: await thumbprint(key.jwk) } });

    const email = uniqueEmail('bad-key');
    await requestMagicLink(email);
    const token = magicLinkToken((await mailbox(email)).at(-1)!);
    for (const bad of [{ ...key.jwk, d: 'secret' }, { ...key.jwk, crv: 'P-384' }, { ...key.jwk, x: 'short' }, 'key']) {
      expect(await call('POST', '/v1/auth/session', { body: { token, key: bad } })).toMatchObject({ status: 400, body: { error: { field: expect.stringMatching(/^key/) } } });
    }
    // Without a key (or a null one) it's an unbound session, while those are allowed.
    expect((await call('POST', '/v1/auth/session', { body: { token, key: null } })).status).toBe(200);
  });

  it('are the only ones that count once REQUIRE_BOUND_SESSIONS is on', async () => {
    const strict = { REQUIRE_BOUND_SESSIONS: 'true' };
    const unbound = await signIn(uniqueEmail('unbound'));
    const bound = await signInBound();
    expect((await call('GET', '/v1/me', { token: unbound.token, settings: strict })).status).toBe(401);
    expect((await call('GET', '/v1/me', { ...bound, settings: strict })).status).toBe(200);
  });
});

describe('a DPoP proof', () => {
  it('works for one request only on every route that changes something, and again on reads', async () => {
    const who = await signInBound(uniqueEmail('replay'));
    const other = await signIn(uniqueEmail('other-host'));
    const theirs = await createParty(other, 'Theirs');
    /** Sends `method path` with a new proof, then again with the very same proof. */
    const twice = async (method: string, path: string, body?: unknown) => {
      const dpop = await proof(who.browserKey, method, path, who.token);
      const first = await call(method, path, { token: who.token, body, headers: { dpop } });
      const again = await call(method, path, { token: who.token, body, headers: { dpop } });
      return { first, again };
    };
    const created = await twice('POST', '/v1/parties', { name: 'Bound party' });
    expect([created.first.status, created.again.status]).toEqual([201, 401]);
    const code = created.first.body.code as string;
    for (const path of ['/v1/me', '/v1/me/parties', '/v1/me/parties/unrevealed']) {
      const { first, again } = await twice('GET', path);
      expect([path, first.status, again.status]).toEqual([path, 200, 200]);
    }
    const routes: [string, string, unknown?][] = [
      ['PATCH', '/v1/me', { name: 'Bound' }],
      ['POST', '/v1/live/ticket'],
      ['POST', '/v1/me/deletion'],
      ['POST', '/v1/parties/invite', { code, emails: [uniqueEmail('invited')] }],
      ['POST', '/v1/parties/join', { code: theirs.code, name: 'Bound' }],
      ['POST', '/v1/parties/join', { code: theirs.code, name: 'Bound' }], // a repeat join checks too
      ['POST', '/v1/parties/leave', { code: theirs.code }],
      ['POST', '/v1/parties/delete', { code }],
      ['POST', '/v1/parties/restore', { code }],
      ['POST', '/v1/me/parties/revealed', { code }],
      ['POST', '/v1/me/sign-out'],
    ];
    for (const [method, path, body] of routes) {
      const { first, again } = await twice(method, path, body);
      expect([method, path, first.status === 401]).toEqual([method, path, false]);
      expect([method, path, again.status, again.body.error?.code]).toEqual([method, path, 401, 'unauthenticated']);
    }
  });

  it('works again on a lookup, which changes nothing', async () => {
    const host = await signInBound();
    const party = (await call('POST', '/v1/parties', { ...host, body: { name: 'Mine' } })).body;
    const dpop = await proof(host.browserKey, 'POST', '/v1/parties/lookup', host.token);
    const lookup = () => call('POST', '/v1/parties/lookup', { token: host.token, body: { code: party.code }, headers: { dpop } });
    expect((await lookup()).body).toMatchObject({ isHost: true });
    expect((await lookup()).body).toMatchObject({ isHost: true });
  });

  it('is refused when repeated on a write, while a retry with a fresh one works', async () => {
    const who = await signInBound();
    const dpop = await proof(who.browserKey, 'PATCH', '/v1/me', who.token);
    const rename = (headers?: Record<string, string>) => call('PATCH', '/v1/me', { ...(headers ? { token: who.token, headers } : who), body: { name: 'Again' } });
    expect((await rename({ dpop })).status).toBe(200);
    expect((await rename({ dpop })).status).toBe(401);
    expect((await rename()).status).toBe(200);
  });
});

describe("a party's live socket", () => {
  it("opens from a ticket that carries the party's code, never a code in the URL, and only for a member", async () => {
    const host = await signIn(uniqueEmail('host'));
    const stranger = await signIn(uniqueEmail('stranger'));
    const party = await createParty(host, 'Live');
    const ticket = async (who: { token: string }, code?: string) =>
      (await call('POST', '/v1/live/ticket', { token: who.token, body: code ? { code } : undefined })).body.ticket as string;
    const open = (path: string) => api(path, { headers: { upgrade: 'websocket', origin: APP } });
    const socket = await open(`/v1/parties/live?ticket=${await ticket(host, party.code)}`);
    expect(socket.status).toBe(101);
    socket.webSocket!.accept();
    socket.webSocket!.close();
    expect((await open(`/v1/parties/live?ticket=${await ticket(stranger, party.code)}`)).status).toBe(403);
    // A ticket without a party opens no party's socket; a party's ticket opens no account socket.
    expect((await open(`/v1/parties/live?code=${party.code}&ticket=${await ticket(host)}`)).status).toBe(401);
    expect((await open(`/v1/me/live?ticket=${await ticket(host, party.code)}`)).status).toBe(401);
  });

  it('gets its ticket under the lookup limit, and the ticket works for five minutes', async () => {
    const host = await signIn(uniqueEmail('host'));
    const ip = uniqueIp();
    for (let i = 0; i < 60; i++) {
      await call('POST', '/v1/parties/lookup', { body: { code: 'QQQQQQQQ' }, ip });
    }
    expect((await call('POST', '/v1/live/ticket', { token: host.token, body: { code: 'QQQQQQQQ' }, ip })).status).toBe(429);
    const { ticket } = (await call('POST', '/v1/live/ticket', { token: host.token })).body;
    const { iat, exp } = await jwt().jwtVerify<{ iat: number; exp: number }>(ticket, 'LiveTicket');
    expect(exp - iat).toBe(5 * 60);
  });
});

describe('encrypted tokens', () => {
  it('are JWE, and nothing in them can be read without the key', async () => {
    const who = await signIn(uniqueEmail('reader'));
    for (const token of [who.token, (await call('POST', '/v1/live/ticket', { token: who.token })).body.ticket as string]) {
      expect(jose.decodeProtectedHeader(token)).toMatchObject({ alg: 'dir', enc: 'A256GCM' });
      const readable = token.split('.').map(part => { try { return atob(part.replace(/-/g, '+').replace(/_/g, '/')); } catch { return ''; } }).join('');
      expect(readable).not.toContain(who.email.split('@')[0]);
    }
  });

  it('are refused with another type, a changed byte, another key, or past their expiry', async () => {
    const who = await signIn(uniqueEmail('forger'));
    const parts = who.token.split('.');
    parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
    const other = await mintUserToken({ sub: nodeIdToStr({ kind: 'User', id: strToNodeId(who.id).id }), email: who.email }, 3600, env.TEST_OTHER_PRIVATE_KEY);
    const expired = await mintUserToken({ sub: nodeIdToStr({ kind: 'User', id: strToNodeId(who.id).id }), email: who.email }, -60);
    const link = await mintEnterRequestToken({ email: who.email, jti: 'x' });
    for (const token of [parts.join('.'), other, expired, link]) {
      expect((await call('GET', '/v1/me', { token })).status).toBe(401);
    }
  });

  it('come with what the app used to read from them: when the session ends, and the link\'s party', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host, 'Linked');
    const email = uniqueEmail('linked');
    await requestMagicLink(email, { party: party.code });
    const entered = await redeem(magicLinkToken((await mailbox(email)).at(-1)!));
    expect(entered.body).toMatchObject({ party: party.code, expiresAt: expect.any(String) });
  });

  it('give a fresh link for an expired one, to the same address and party, and refuse one a week too old', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host, 'Again');
    const email = uniqueEmail('again');
    const expired = await mintEnterRequestToken({ email, jti: crypto.randomUUID(), party: party.code }, -3600);
    expect(await redeem(expired)).toMatchObject({ status: 400, body: { error: { code: 'link_expired' } } });
    expect((await call('POST', '/v1/auth/magic-link/again', { body: { token: expired } })).status).toBe(202);
    const fresh = magicLinkToken((await mailbox(email)).at(-1)!);
    expect((await redeem(fresh)).body).toMatchObject({ party: party.code, user: { email } });
    const ancient = await mintEnterRequestToken({ email, jti: crypto.randomUUID() }, -8 * 24 * 60 * 60);
    expect(await call('POST', '/v1/auth/magic-link/again', { body: { token: ancient } })).toMatchObject({ status: 400, body: { error: { code: 'invalid_link' } } });
  });
});
