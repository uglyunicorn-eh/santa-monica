import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';

import { tokens } from 'src/api/schemas';
import { authenticate } from 'src/api/session';
import { UserToken } from 'src/api/types';
import { emailClaim, openEmail, sealEmail, sealsTokenEmail, tokenEmail } from 'src/utils/tokenEmail';

import { jwt, request, signIn, testEnv, uniqueEmail } from './helpers';

const sealing = () => testEnv({ SEAL_TOKEN_EMAIL: 'true' });
const payload = (token: string) => JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));

describe('the sealed email in tokens', () => {
  it('opens only what it sealed, with the same key', async () => {
    const sealed = await sealEmail(env, 'someone@example.com');
    expect(sealed).not.toContain('someone');
    expect(await openEmail(env, sealed)).toBe('someone@example.com');
    expect(await sealEmail(env, 'someone@example.com')).not.toBe(sealed); // a fresh IV every time
    const flipped = sealed.slice(0, -2) + (sealed.at(-2) === 'A' ? 'B' : 'A') + sealed.at(-1);
    expect(await openEmail(env, flipped)).toBeUndefined();
    expect(await openEmail(env, 'not base64!')).toBeUndefined();
    expect(await openEmail({ ...env, JWT_PRIVATE_KEY: env.TEST_OTHER_PRIVATE_KEY }, sealed)).toBeUndefined();
  });

  it('is issued only once SEAL_TOKEN_EMAIL is on, and both kinds are read', async () => {
    expect(sealsTokenEmail(env)).toBe(false);
    expect(await emailClaim(env, 'a@example.com')).toEqual({ email: 'a@example.com' });
    const sealed = await emailClaim(sealing(), 'a@example.com');
    expect(sealed).toEqual({ em: expect.any(String) });
    expect(await tokenEmail(env, sealed)).toBe('a@example.com');
    expect(await tokenEmail(env, { email: 'b@example.com' })).toBe('b@example.com');
  });

  it('accepts a token with one email claim, never both or neither', () => {
    const ok = (claims: object) => v.safeParse(tokens.user, { sub: btoa('User:abc'), ...claims }).success;
    expect(ok({ email: 'a@example.com' })).toBe(true);
    expect(ok({ em: 'sealed' })).toBe(true);
    expect(ok({ email: 'a@example.com', em: 'sealed' })).toBe(false);
    expect(ok({})).toBe(false);
  });

  it('signs in with a sealed email, and every signed-in route reads it', async () => {
    const who = await signIn(uniqueEmail('sealed'), 'Sealed');
    const token = await jwt().issueToken<UserToken>('UserToken', { sub: who.nodeId, ...await emailClaim(sealing(), who.email), ver: who.tokenVersion }, { ttl: 60 });
    expect(payload(token)).toMatchObject({ em: expect.any(String) });
    expect(JSON.stringify(payload(token))).not.toContain(who.email);
    expect(await request('GET', '/v1/me', { token })).toMatchObject({ status: 200, body: { email: who.email } });
    expect(await authenticate(env, `Bearer ${token}`)).toMatchObject({ userId: who.id, email: who.email });
    // A sealed email that doesn't open is no session at all.
    const forged = await jwt().issueToken<UserToken>('UserToken', { sub: who.nodeId, em: 'bm9wZQ', ver: who.tokenVersion }, { ttl: 60 });
    expect(await authenticate(env, `Bearer ${forged}`)).toBeUndefined();
  });

  it('issues sealed session tokens and live tickets when it is on, which then work as before', async () => {
    const email = uniqueEmail('issued');
    const link = await jwt().issueToken('EnterRequest', { email, jti: crypto.randomUUID() }, { ttl: 60 });
    const { body } = await request('POST', '/v1/auth/session', { body: { token: link }, env: sealing() });
    expect(payload(body.userToken)).toEqual(expect.objectContaining({ em: expect.any(String) }));
    expect(payload(body.userToken).email).toBeUndefined();
    const { body: { ticket } } = await request('POST', '/v1/live/ticket', { token: body.userToken, env: sealing() });
    expect(payload(ticket)).toEqual(expect.objectContaining({ em: expect.any(String) }));
    expect(payload(ticket).email).toBeUndefined();
    const res = await request('GET', '/v1/me', { token: body.userToken });
    expect(res.body.email).toBe(email);
  });
});
