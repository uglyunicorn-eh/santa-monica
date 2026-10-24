import { describe, expect, it } from 'vitest';

import { nodeIdToStr } from 'src/utils/strings/nodeId';

import {
  ENTER, ENTER_REQUEST, createParty, gql, magicLinkToken, mailbox, mintEnterRequestToken, mintUserToken,
  signInWithMagicLink, uniqueEmail,
} from './support';

const USER = '{ user { id name } }';

describe('magic-link sign-in', () => {
  it('emails a magic link that signs the person in', async () => {
    const email = uniqueEmail('magic');
    const requested = await gql(ENTER_REQUEST, { email });
    expect(requested.data.auth.enterRequest).toEqual({ status: 'ok', userErrors: null });

    const [mail] = await mailbox(email);
    expect(mail.to).toEqual([email]);
    expect(mail.from).toEqual({ email: 'info@gnomik.me', name: 'Anonymous Ded Morozes' });
    expect(mail.subject).toBe('Sign in to Anonymous Ded Morozes');
    expect(mail.html).toContain('https://gnomik.me/enter/');
    expect(mail.html).toContain('https://api.test/email/gnomik.png');
    expect(mail.text).toContain('https://gnomik.me/terms/');

    const entered = await gql(ENTER, { token: magicLinkToken(mail) });
    expect(entered.data.auth.enter).toMatchObject({ status: 'ok', userErrors: null, user: { name: '' } });

    const me = await gql(USER, {}, { token: entered.data.auth.enter.userToken });
    expect(me.data.user).toEqual(entered.data.auth.enter.user);
  });

  it('creates the account once: the same email (any case) is the same person', async () => {
    const email = uniqueEmail('same');
    const first = await signInWithMagicLink(email);
    const second = await signInWithMagicLink(email.toUpperCase());
    expect(second.id).toBe(first.id);
    expect(await mailbox(email)).toHaveLength(2);
  });

  it('lets each magic link be used only once', async () => {
    const email = uniqueEmail('reuse');
    await gql(ENTER_REQUEST, { email });
    await gql(ENTER_REQUEST, { email });
    const [first, second] = (await mailbox(email)).map(magicLinkToken);

    expect((await gql(ENTER, { token: first })).data.auth.enter.status).toBe('ok');
    expect((await gql(ENTER, { token: first })).data.auth.enter).toEqual({
      status: 'error',
      userErrors: [{ fieldName: 'enterRequestToken', messages: ['This magic link has already been used. Please request a new one.'] }],
      userToken: null,
      user: null,
    });

    // An unused link from the same person still works.
    expect((await gql(ENTER, { token: second })).data.auth.enter.status).toBe('ok');
  });

  it('lets only one of two simultaneous clicks through', async () => {
    const email = uniqueEmail('race');
    await gql(ENTER_REQUEST, { email });
    const token = magicLinkToken((await mailbox(email))[0]);
    const results = await Promise.all([gql(ENTER, { token }), gql(ENTER, { token }), gql(ENTER, { token })]);
    expect(results.map(r => r.data.auth.enter.status).sort()).toEqual(['error', 'error', 'ok']);
  });

  it('accepts a party code for an existing party', async () => {
    const host = await signInWithMagicLink(uniqueEmail('host'));
    const party = await createParty(host);
    const res = await gql(ENTER_REQUEST, { email: uniqueEmail('invited'), party: party.code });
    expect(res.data.auth.enterRequest.status).toBe('ok');
  });

  it('rejects a party code that does not exist', async () => {
    const res = await gql(ENTER_REQUEST, { email: uniqueEmail(), party: 'QQQQQ' });
    expect(res.data.auth.enterRequest).toEqual({
      status: 'error', userErrors: [{ fieldName: 'party', messages: ['Invalid party code.'] }],
    });
  });

  it('validates the email and the party code format', async () => {
    const badEmail = await gql(ENTER_REQUEST, { email: 'not-an-email' });
    expect(badEmail.data.auth.enterRequest).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'email' }] });

    const badCode = await gql(ENTER_REQUEST, { email: uniqueEmail(), party: 'abc' });
    expect(badCode.data.auth.enterRequest).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'party' }] });
  });

  it('reports a failed delivery instead of pretending the link was sent', async () => {
    const res = await gql(ENTER_REQUEST, { email: `fail+${uniqueEmail()}` });
    expect(res.data.auth.enterRequest).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'email' }] });
  });
});

describe('rate limiting', () => {
  it('allows 3 magic links per email per minute', async () => {
    const email = uniqueEmail('limited');
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await gql(ENTER_REQUEST, { email })).data.auth.enterRequest.status);
    }
    expect(statuses).toEqual(['ok', 'ok', 'ok', 'error', 'error']);
    expect(await mailbox(email)).toHaveLength(3);
  });

  it('counts the email case-insensitively', async () => {
    const email = uniqueEmail('cased');
    const variants = [email, email.toUpperCase(), email, email.toUpperCase()];
    const statuses = [];
    for (const variant of variants) {
      statuses.push((await gql(ENTER_REQUEST, { email: variant })).data.auth.enterRequest.status);
    }
    expect(statuses).toEqual(['ok', 'ok', 'ok', 'error']);
  });

  it('allows 10 magic links per IP per minute, across emails', async () => {
    const ip = '203.0.113.77';
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await gql(ENTER_REQUEST, { email: uniqueEmail('ip') }, { ip })).data.auth.enterRequest.status);
    }
    expect(statuses.slice(0, 10).every(s => s === 'ok')).toBe(true);
    expect(statuses.slice(10)).toEqual(['error', 'error']);
  });
});

describe('tokens', () => {
  const invalid = { status: 'error', userErrors: [{ fieldName: 'enterRequestToken', messages: ['Invalid request token.'] }] };

  it('rejects a garbage magic-link token', async () => {
    expect((await gql(ENTER, { token: 'nope' })).data.auth.enter).toMatchObject(invalid);
  });

  it('rejects an expired magic-link token', async () => {
    const token = await mintEnterRequestToken({ email: uniqueEmail() }, -60);
    expect((await gql(ENTER, { token })).data.auth.enter).toMatchObject(invalid);
  });

  it('rejects a magic-link token signed with another secret', async () => {
    const token = await mintEnterRequestToken({ email: uniqueEmail() }, 300, 'some-other-secret-that-is-long-enough');
    expect((await gql(ENTER, { token })).data.auth.enter).toMatchObject(invalid);
  });

  it('rejects a session token used as a magic-link token', async () => {
    const person = await signInWithMagicLink(uniqueEmail());
    expect((await gql(ENTER, { token: person.token })).data.auth.enter).toMatchObject(invalid);
  });

  it('ignores a magic-link token used as a session token', async () => {
    const email = uniqueEmail();
    await gql(ENTER_REQUEST, { email });
    const token = magicLinkToken((await mailbox(email))[0]);
    expect((await gql(USER, {}, { token })).data.user).toBeNull();
  });

  it('ignores expired, forged and malformed session tokens', async () => {
    const person = await signInWithMagicLink(uniqueEmail());
    const sub = person.id;
    const expired = await mintUserToken({ sub, email: person.email }, -60);
    const forged = await mintUserToken({ sub, email: person.email }, 3600, 'some-other-secret-that-is-long-enough');
    const notAUser = await mintUserToken({ sub: nodeIdToStr({ kind: 'Party', id: 'QWERT' }), email: person.email });

    for (const token of [expired, forged, notAUser, 'garbage']) {
      expect((await gql(USER, {}, { token })).data.user).toBeNull();
    }
  });

  it('returns no user without a session', async () => {
    expect((await gql(USER)).data.user).toBeNull();
  });
});
