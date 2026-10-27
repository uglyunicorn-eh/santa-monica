import { describe, expect, it } from 'vitest';

import { AGAIN_WITHIN_S } from 'src/api/routes/auth';
import { EnterRequestToken } from 'src/api/types';

import { jwt, mailer, request, signIn, testEnv, uniqueEmail } from './helpers';

// Plan section 4.2: tokens are encrypted, so the app reads nothing from them; the API tells it what it needs.

const link = (payload: Partial<EnterRequestToken>, ttl = 300) =>
  jwt().issueToken('EnterRequest', { email: uniqueEmail(), jti: crypto.randomUUID(), ...payload }, { ttl });

const tokenIn = (text: string) => /#([\w-]+(?:\.[\w-]*){4})/.exec(text)![1];

describe('signing in', () => {
  it("answers with when the session ends and the link's party, since the app can't read the token", async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const { body: party } = await request('POST', '/v1/parties', { token: host.token, body: { name: 'P' } });
    const before = Date.now();
    const plain = await request('POST', '/v1/auth/session', { body: { token: await link({}) } });
    expect(plain.body).toMatchObject({ party: null, expiresAt: expect.any(String) });
    expect(Date.parse(plain.body.expiresAt) - before).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    const withParty = await request('POST', '/v1/auth/session', { body: { token: await link({ party: party.code }) } });
    expect(withParty.body.party).toBe(party.code);
  });

  it('tells an expired link from an invalid one', async () => {
    expect(await request('POST', '/v1/auth/session', { body: { token: await link({}, -60) } })).toMatchObject({
      status: 400, body: { error: { code: 'link_expired', field: 'token' } },
    });
    expect(await request('POST', '/v1/auth/session', { body: { token: 'garbage' } })).toMatchObject({
      status: 400, body: { error: { code: 'invalid_link' } },
    });
  });
});

describe('POST /v1/auth/magic-link/again', () => {
  it('emails a fresh link for an expired one, to the address inside it, with its party', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const { body: party } = await request('POST', '/v1/parties', { token: host.token, body: { name: 'P' } });
    const { sent, EMAIL } = mailer();
    const email = uniqueEmail('again');
    const expired = await link({ email, typed: email.toUpperCase(), party: party.code }, -3600);
    expect((await request('POST', '/v1/auth/magic-link/again', { body: { token: expired }, env: testEnv({ EMAIL }) })).status).toBe(202);
    expect(sent.map(m => m.to)).toEqual([email]);
    const fresh = await jwt().jwtVerify<EnterRequestToken>(tokenIn(sent[0].text), 'EnterRequest');
    expect(fresh).toMatchObject({ email, typed: email.toUpperCase(), party: party.code });
    expect(fresh.exp).toBeGreaterThan(Date.now() / 1000);
    // A link that hasn't expired works too.
    expect((await request('POST', '/v1/auth/magic-link/again', { body: { token: await link({ email }) }, env: testEnv({ EMAIL }) })).status).toBe(202);
  });

  it('refuses a link expired too long ago, another kind of token, and garbage', async () => {
    const tooOld = await link({}, -AGAIN_WITHIN_S - 3600);
    const session = await jwt().issueToken('UserToken', { sub: 'x', email: uniqueEmail() }, { ttl: 60 });
    for (const token of [tooOld, session, 'garbage']) {
      expect(await request('POST', '/v1/auth/magic-link/again', { body: { token } })).toMatchObject({ status: 400, body: { error: { code: 'invalid_link' } } });
    }
  });

  it('is limited like a new request', async () => {
    const denied = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    expect(await request('POST', '/v1/auth/magic-link/again', { body: { token: await link({}, -60) }, env: testEnv({ MAIL_RATE_LIMIT_ADDRESS: denied }) }))
      .toMatchObject({ status: 429, body: { error: { code: 'rate_limited' } } });
  });
});
