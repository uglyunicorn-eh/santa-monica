import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { nodeIdToStr } from 'src/utils/strings/nodeId';

import {
  apiError, createParty, magicLinkToken, mailbox, me, mintEnterRequestToken, mintUserToken, newKey, redeem,
  requestMagicLink, signIn, uniqueEmail,
} from './support';

describe('magic-link sign-in', () => {
  it('emails a magic link that signs the person in', async () => {
    const email = uniqueEmail('magic');
    const requested = await requestMagicLink(email);
    expect(requested).toEqual({ status: 202, body: { ok: true } });

    const [mail] = await mailbox(email);
    expect(mail.to).toEqual([email]);
    expect(mail.from).toEqual({ email: 'info@gnomik.me', name: 'Anonymous Ded Morozes' });
    expect(mail.subject).toBe('Sign in to Anonymous Ded Morozes');
    expect(mail.html).toContain('https://gnomik.me/enter/link#');
    expect(mail.html).toContain('https://api.test/email/gnomik.png');
    expect(mail.text).toContain('https://gnomik.me/terms/');

    const entered = await redeem(magicLinkToken(mail));
    expect(entered).toMatchObject({ status: 200, body: { user: { name: '', email } } });

    expect(await me({ token: entered.body.userToken })).toEqual({ status: 200, body: entered.body.user });
  });

  it('creates the account once: the same email (any case) is the same person', async () => {
    const email = uniqueEmail('same');
    const first = await signIn(email);
    const second = await signIn(email.toUpperCase());
    expect(second.id).toBe(first.id);
    expect(await mailbox(email)).toHaveLength(2);
  });

  it('lets each magic link be used only once', async () => {
    const email = uniqueEmail('reuse');
    await requestMagicLink(email);
    await requestMagicLink(email);
    const [first, second] = (await mailbox(email)).map(magicLinkToken);

    expect((await redeem(first)).status).toBe(200);
    expect(await redeem(first)).toEqual({
      status: 409, body: apiError('link_used', 'This magic link has already been used. Please request a new one.', 'token'),
    });

    // An unused link from the same person still works.
    expect((await redeem(second)).status).toBe(200);
  });

  it('lets only one of two simultaneous clicks through', async () => {
    const email = uniqueEmail('race');
    await requestMagicLink(email);
    const token = magicLinkToken((await mailbox(email))[0]);
    const results = await Promise.all([redeem(token), redeem(token), redeem(token)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409, 409]);
  });

  it('accepts a party code for an existing party, in any case', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host);
    expect((await requestMagicLink(uniqueEmail('invited'), { party: party.code })).status).toBe(202);
    expect((await requestMagicLink(uniqueEmail('invited'), { party: party.code.toLowerCase() })).status).toBe(202);
  });

  it('rejects a party code that does not exist', async () => {
    expect(await requestMagicLink(uniqueEmail(), { party: 'QQQQQ' })).toEqual({
      status: 404, body: apiError('not_found', 'Invalid party code.', 'party'),
    });
  });

  it('validates the email and the party code format', async () => {
    expect(await requestMagicLink('not-an-email')).toMatchObject({ status: 400, body: apiError('invalid', undefined, 'email') });
    expect(await requestMagicLink(uniqueEmail(), { party: 'abc' })).toMatchObject({ status: 400, body: apiError('invalid', undefined, 'party') });
  });

  it('reports a failed delivery instead of pretending the link was sent', async () => {
    expect(await requestMagicLink(`fail+${uniqueEmail()}`)).toMatchObject({ status: 503, body: apiError('unavailable', undefined, 'email') });
  });
});

describe('repeating a sign-in request (Idempotency-Key)', () => {
  it('sends one email and charges the rate limit once, however often the same request is repeated', async () => {
    const email = uniqueEmail('again');
    const key = newKey();
    for (let i = 0; i < 5; i++) {
      expect(await requestMagicLink(email, { key })).toEqual({ status: 202, body: { ok: true } });
    }
    expect(await mailbox(email)).toHaveLength(1);
    // The per-address limit (3 a minute) still has two left: the repeats cost nothing.
    expect((await requestMagicLink(email)).status).toBe(202);
    expect((await requestMagicLink(email)).status).toBe(202);
    expect((await requestMagicLink(email)).status).toBe(429);
  });

  it('treats the same key for another party code as a new request', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host);
    const email = uniqueEmail('codes');
    const key = newKey();
    await requestMagicLink(email, { key });
    await requestMagicLink(email, { key, party: party.code });
    expect(await mailbox(email)).toHaveLength(2);
  });

  it('frees the key when the email could not be sent, so a retry tries again', async () => {
    const email = `fail+${uniqueEmail()}`;
    const key = newKey();
    expect((await requestMagicLink(email, { key })).status).toBe(503);
    expect((await requestMagicLink(email, { key })).status).toBe(503);
  });

  it('refuses a malformed key instead of ignoring it', async () => {
    expect(await requestMagicLink(uniqueEmail(), { key: 'short' })).toMatchObject({ status: 400, body: apiError('invalid', undefined, 'Idempotency-Key') });
    expect(await requestMagicLink(uniqueEmail(), { key: 'x'.repeat(101) })).toMatchObject({ status: 400 });
    expect(await requestMagicLink(uniqueEmail(), { key: 'has spaces in it, sixteen+' })).toMatchObject({ status: 400 });
  });

  it('signs in again when the same request repeats the link, but refuses anyone else', async () => {
    const email = uniqueEmail('retry');
    await requestMagicLink(email);
    const token = magicLinkToken((await mailbox(email))[0]);
    const key = newKey();

    const first = await redeem(token, { key });
    const again = await redeem(token, { key });
    expect(again.status).toBe(200);
    expect(again.body.user).toEqual(first.body.user);
    expect(await me({ token: again.body.userToken })).toMatchObject({ status: 200 });

    expect((await redeem(token, { key: newKey() })).status).toBe(409);
    expect((await redeem(token)).status).toBe(409);
  });

  it('does not let a key used on one link redeem another', async () => {
    const email = uniqueEmail('other');
    await requestMagicLink(email);
    await requestMagicLink(email);
    const [first, second] = (await mailbox(email)).map(magicLinkToken);
    const key = newKey();
    expect((await redeem(first, { key })).status).toBe(200);
    expect((await redeem(second, { key })).status).toBe(200);
    expect((await redeem(second, { key: newKey() })).status).toBe(409);
  });
});

describe('rate limiting', () => {
  it('allows 3 magic links per email per minute', async () => {
    const email = uniqueEmail('limited');
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await requestMagicLink(email)).status);
    }
    expect(statuses).toEqual([202, 202, 202, 429, 429]);
    expect(await mailbox(email)).toHaveLength(3);
  });

  it('counts the email case-insensitively', async () => {
    const email = uniqueEmail('cased');
    const statuses = [];
    for (const variant of [email, email.toUpperCase(), email, email.toUpperCase()]) {
      statuses.push((await requestMagicLink(variant)).status);
    }
    expect(statuses).toEqual([202, 202, 202, 429]);
  });

  it('allows 10 magic links per IP per minute, across emails', async () => {
    const ip = '203.0.113.77';
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await requestMagicLink(uniqueEmail('ip'), { ip })).status);
    }
    expect(statuses.slice(0, 10).every(s => s === 202)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

describe('tokens', () => {
  const invalid = { status: 400, body: apiError('invalid_link', 'Invalid request token.', 'token') };

  it('rejects a garbage magic-link token', async () => {
    expect(await redeem('nope')).toEqual(invalid);
  });

  it('tells an expired magic-link token apart, so the app can offer a fresh one', async () => {
    expect(await redeem(await mintEnterRequestToken({ email: uniqueEmail(), jti: 'x' }, -60))).toEqual({
      status: 400, body: apiError('link_expired', 'This magic link has expired. Please request a new one.', 'token'),
    });
  });

  it('rejects a magic-link token signed with another key, or without an id', async () => {
    expect(await redeem(await mintEnterRequestToken({ email: uniqueEmail(), jti: 'x' }, 300, env.TEST_OTHER_PRIVATE_KEY))).toEqual(invalid);
    expect(await redeem(await mintEnterRequestToken({ email: uniqueEmail() }))).toEqual(invalid);
  });

  it('rejects a session token used as a magic-link token', async () => {
    const person = await signIn(uniqueEmail());
    expect(await redeem(person.token)).toEqual(invalid);
  });

  it('refuses a magic-link token used as a session token', async () => {
    const email = uniqueEmail();
    await requestMagicLink(email);
    const token = magicLinkToken((await mailbox(email))[0]);
    expect(await me({ token })).toMatchObject({ status: 401, body: apiError('unauthenticated') });
  });

  it('refuses expired, forged and malformed session tokens', async () => {
    const person = await signIn(uniqueEmail());
    const sub = person.id;
    const expired = await mintUserToken({ sub, email: person.email }, -60);
    const forged = await mintUserToken({ sub, email: person.email }, 3600, env.TEST_OTHER_PRIVATE_KEY);
    const notAUser = await mintUserToken({ sub: nodeIdToStr({ kind: 'Party', id: 'QWERT' }), email: person.email });

    for (const token of [expired, forged, notAUser, 'garbage', 'a.b.c']) {
      expect((await me({ token })).status).toBe(401);
    }
  });

  it('answers 401 without a session', async () => {
    expect(await me({})).toEqual({ status: 401, body: apiError('unauthenticated', 'Your session has expired. Please sign in again.') });
  });
});

describe('a sign-in request', () => {
  it('stores nothing until its link is used: then the account is made', async () => {
    const email = uniqueEmail('not-yet');
    expect((await requestMagicLink(email, { key: newKey() })).status).toBe(202);
    const tables = () => runInDurableObject(env.USER.getByName(email), async (_i, state) =>
      state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'").toArray().map(r => r.name));
    expect(await tables()).toEqual([]);
    expect((await redeem(magicLinkToken((await mailbox(email)).at(-1)!))).status).toBe(200);
    expect(await tables()).toContain('user');
  });
});
