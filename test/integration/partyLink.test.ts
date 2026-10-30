import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { PartySignInToken } from 'src/api/types';

import {
  Person, apiError, browserKey, call, changeEmail, createParty, deleteAccount, drawParty, joinParty, jwt, leaveParty, linkToken,
  magicLinkToken, mailbox, newKey, redeem, settleParty, signIn, uniqueEmail, viewParty,
} from './support';

// The sign-in link in a party's "dice are rolled" email and in the host's reminder the day before: it signs in only
// the member it was sent to, once, and never makes an account.

const ROLLED = 'Link party: the dice are rolled!';

const useLink = (token: string, key?: string, body: Record<string, unknown> = {}) =>
  call('POST', '/v1/auth/party-link', { key, body: { token, ...body } });

/** The token in the newest email to `email` with `subject`, linking to the party's sign-in page. */
async function emailedLink(email: string, code: string, subject: (s: string) => boolean) {
  const mail = (await mailbox(email)).filter(m => subject(m.subject)).at(-1)!;
  return linkToken(mail, `p/${code}/sign-in`);
}

/** A rolled party of a host and a guest, with each one's link from the "dice are rolled" email. */
async function rolledParty() {
  const host = await signIn(uniqueEmail('host'));
  const guest = await signIn(uniqueEmail('guest'));
  const party = await createParty(host, 'Link party');
  await joinParty(guest, party, 'Guest');
  await drawParty(host, party);
  expect(await settleParty(party.code)).toBe(0);
  const link = (who: Person) => emailedLink(who.email, party.code, s => s === ROLLED);
  return { host, guest, party, link };
}

/** A link the way the party mails one, for tests that need it on an open party. */
const mintLink = (who: Person, party: string, ttl = 3600) =>
  jwt().issueToken<PartySignInToken>('PartySignIn', { sub: who.id, email: who.email, party, jti: crypto.randomUUID() }, { ttl });

describe('the link in the "dice are rolled" email', () => {
  it('signs the member in and returns the party, with their match to see', async () => {
    const { guest, party, link } = await rolledParty();
    const key = await browserKey();
    const signedIn = await useLink(await link(guest), newKey(), { key: key.jwk });
    expect(signedIn).toMatchObject({ status: 200, body: { party: party.code, user: { id: guest.id, email: guest.email } } });

    const seen = await call('POST', '/v1/parties/lookup', { body: { code: party.code }, token: signedIn.body.userToken, browserKey: key });
    expect(seen.body).toMatchObject({ isJoined: true, isClosed: true, target: { name: expect.any(String) } });
  });

  it('works once: a second use is link_used, and the same request (same Idempotency-Key) signs in again', async () => {
    const { host, link } = await rolledParty();
    const token = await link(host);
    const key = newKey();
    const first = await useLink(token, key);
    expect(first.status).toBe(200);
    expect(await useLink(token, key)).toMatchObject({ status: 200, body: { user: { id: host.id } } });
    expect(await useLink(token, newKey())).toMatchObject({ status: 409, body: apiError('link_used', undefined, 'token') });
    expect(await useLink(token)).toMatchObject({ status: 409, body: apiError('link_used', undefined, 'token') });
  });

  it('after the member changes their email, the link to the old address is not_member, and makes no account there', async () => {
    const { guest, party, link } = await rolledParty();
    const token = await link(guest);
    const moved = await changeEmail(guest, uniqueEmail('moved'));

    expect(await useLink(token, newKey())).toMatchObject({ status: 403, body: apiError('not_member', undefined, 'token') });
    expect(await env.USER.getByName(guest.email).get()).toBeNull();
    // The member is still in the party, at the new address.
    expect((await viewParty(party.code, moved)).body).toMatchObject({ isJoined: true });
  });

  it('is not_member once the account is deleted', async () => {
    const { guest, link } = await rolledParty();
    const token = await link(guest);
    await deleteAccount(guest);
    expect(await useLink(token, newKey())).toMatchObject({ status: 403, body: apiError('not_member', undefined, 'token') });
    expect(await env.USER.getByName(guest.email).get()).toBeNull();
  });

  it('when expired is link_expired, and /magic-link/again mails a fresh link for the party', async () => {
    const { guest, party } = await rolledParty();
    const expired = await mintLink(guest, party.code, -60);
    expect(await useLink(expired, newKey())).toMatchObject({ status: 400, body: apiError('link_expired', undefined, 'token') });

    expect(await call('POST', '/v1/auth/magic-link/again', { key: newKey(), body: { token: expired } })).toMatchObject({ status: 202 });
    const fresh = await redeem(magicLinkToken((await mailbox(guest.email)).at(-1)!));
    expect(fresh).toMatchObject({ status: 200, body: { party: party.code, user: { id: guest.id } } });
  });

  it('a message queued before links existed (no user id) still goes out, with the bare party link', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host, 'Old message');
    await runInDurableObject(env.PARTY.getByName(party.code), async instance => {
      (instance as unknown as { enqueue(message: object): void }).enqueue({ kind: 'mail.partyNotification', email: host.email, partyName: 'Old message', slug: party.code });
    });
    expect(await settleParty(party.code)).toBe(0);
    const [mail] = (await mailbox(host.email)).filter(m => m.subject === 'Old message: the dice are rolled!');
    expect(mail.text).toContain(`https://gnomik.me/p/${party.code}/ )`);
    expect(mail.text).not.toContain('sign-in');
  });
});

describe('a link for someone no longer in the party', () => {
  it('is not_member after they leave, and is left unused for when they are back', async () => {
    const host = await signIn(uniqueEmail('host'));
    const guest = await signIn(uniqueEmail('guest'));
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');
    const token = await mintLink(guest, party.code);

    await leaveParty(guest, party);
    expect(await useLink(token, newKey())).toMatchObject({ status: 403, body: apiError('not_member', undefined, 'token') });
    await joinParty(guest, party, 'Guest');
    expect(await useLink(token, newKey())).toMatchObject({ status: 200, body: { user: { id: guest.id } } });
  });
});

describe("the link in the host's reminder the day before", () => {
  it('signs the host in', async () => {
    const host = await signIn(uniqueEmail('host'));
    const guest = await signIn(uniqueEmail('guest'));
    const created = await call('POST', '/v1/parties', {
      token: host.token, body: { name: 'Remind me', dueAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() },
    });
    const party = created.body;
    await joinParty(guest, party, 'Guest');
    await runInDurableObject(env.PARTY.getByName(party.code), async (_i, state) => {
      state.storage.sql.exec('UPDATE party SET remind_at = ?', Date.now() - 1000);
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(env.PARTY.getByName(party.code));
    expect(await settleParty(party.code)).toBe(0);

    const token = await emailedLink(host.email, party.code, s => s.endsWith('starts in about a day'));
    expect(await useLink(token, newKey())).toMatchObject({ status: 200, body: { party: party.code, user: { id: host.id } } });
  });
});
