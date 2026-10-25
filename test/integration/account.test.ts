import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { UserToken } from 'src/apollo/types';
import { nodeIdToStr, strToNodeId } from 'src/utils/strings/nodeId';

import {
  CLOSE_PARTY, JOIN_PARTY, LEAVE_PARTY, PARTY, Person, createParty, gql, joinParty, jwt, mailbox, settleParty,
  signInWithMagicLink, uniqueEmail,
} from './support';

const person = (label: string) => signInWithMagicLink(uniqueEmail(label));

const USER = `{ user { id name email } }`;
const HISTORY = `{ partyHistory(first: 50) { items { code isClosed } } }`;
const REQUEST_DELETION = `mutation { profile { requestAccountDeletion { status userErrors { fieldName messages } } } }`;
const CONFIRM_DELETION = `mutation ($token: String!) { profile { confirmAccountDeletion(input: { token: $token }) { status userErrors { fieldName messages } } } }`;
const REQUEST_CHANGE = `mutation ($email: String!) { profile { requestEmailChange(input: { email: $email }) { status userErrors { fieldName messages } } } }`;
const CONFIRM_CHANGE = `mutation ($token: String!) {
  profile { confirmEmailChange(input: { token: $token }) { status userErrors { fieldName messages } userToken user { id name email } } }
}`;

/** The token from the last account link mailed to an address (https://gnomik.me/profile/<path>/<token>). */
async function linkFrom(email: string, path: 'delete' | 'email') {
  const mail = (await mailbox(email)).at(-1)!;
  const match = new RegExp(`https://gnomik\\.me/profile/${path}/([\\w-]+\\.[\\w-]+\\.[\\w-]+)`).exec(mail.text ?? '');
  if (!match) {
    throw new Error(`No ${path} link in the last email to ${email}`);
  }
  return match[1];
}

const closeParty = (host: Person, party: { id: string }) => gql(CLOSE_PARTY, { party: party.id }, { token: host.token });

const memberEmail = (code: string, userId: string) =>
  runInDurableObject(env.PARTY.getByName(code), async (_i, state) =>
    state.storage.sql.exec<{ member_email: string | null }>('SELECT member_email FROM memberships WHERE member_id = ?', userId).toArray()[0]?.member_email);

const rawId = (person: Person) => strToNodeId(person.id).id;

describe('deleting an account', () => {
  it('needs a session to ask for the link', async () => {
    expect((await gql(REQUEST_DELETION)).errors?.[0]?.message).toBe('UNAUTHENTICATED');
  });

  it('emails a link that deletes the account: hosted open parties go, joined ones are left, drawn ones keep the draw', async () => {
    const me = await person('me');
    const friend = await person('friend');
    const other = await person('other');
    const mine = await createParty(me, 'Mine');
    await joinParty(friend, mine, 'Friend');
    const theirs = await createParty(friend, 'Theirs');
    await joinParty(me, theirs, 'Me');
    const drawn = await createParty(friend, 'Drawn');
    await joinParty(me, drawn, 'Me in drawn');
    await joinParty(other, drawn, 'Other');
    await closeParty(friend, drawn);

    expect((await gql(REQUEST_DELETION, {}, { token: me.token })).data.profile.requestAccountDeletion).toEqual({ status: 'ok', userErrors: null });
    const token = await linkFrom(me.email, 'delete');

    // The link works on its own, without a session.
    expect((await gql(CONFIRM_DELETION, { token })).data.profile.confirmAccountDeletion).toEqual({ status: 'ok', userErrors: null });

    expect((await gql(USER, {}, { token: me.token })).data.user).toBeNull();
    expect((await gql(PARTY, { code: mine.code }, { token: friend.token })).data.party).toBeNull();
    expect((await joinParty(other, mine, 'Late'))).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'party', messages: ['Party does not exist.'] }] });
    expect((await gql(PARTY, { code: theirs.code }, { token: friend.token })).data.party).toMatchObject({ participantCount: 1, participants: ['Friend'] });

    // In the drawn party the names stay, so whoever drew me still knows who to buy for.
    const drawnView = (await gql(PARTY, { code: drawn.code }, { token: friend.token })).data.party;
    expect(drawnView.participants).toEqual(['Friend', 'Me in drawn', 'Other']);
    expect(await memberEmail(drawn.code, rawId(me))).toBeUndefined();

    await settleParty(mine.code);
    expect((await gql(HISTORY, {}, { token: friend.token })).data.partyHistory.items.map((p: any) => p.code).sort()).toEqual([theirs.code, drawn.code].sort());
  });

  it('leaves the deleted account\'s old token unable to see its target or join anything', async () => {
    const host = await person('host');
    const me = await person('me');
    const drawn = await createParty(host, 'Drawn');
    await joinParty(me, drawn, 'Me');
    await closeParty(host, drawn);
    expect((await gql(PARTY, { code: drawn.code }, { token: me.token })).data.party.target).toMatchObject({ name: '' });

    await gql(REQUEST_DELETION, {}, { token: me.token });
    await gql(CONFIRM_DELETION, { token: await linkFrom(me.email, 'delete') });

    expect((await gql(PARTY, { code: drawn.code }, { token: me.token })).data.party).toMatchObject({ isJoined: false, target: null, participants: null });
    const open = await createParty(host, 'Open');
    expect((await gql(JOIN_PARTY, { party: open.id, name: 'Ghost' }, { token: me.token })).data.parties.joinParty).toMatchObject({ status: 'error', userErrors: [{ fieldName: null }] });
    expect((await gql(`mutation { parties { createParty(input: { name: "Nope" }) { status } } }`, {}, { token: me.token })).data.parties.createParty.status).toBe('error');
  });

  it('refuses a replayed or expired link', async () => {
    const me = await person('me');
    await gql(REQUEST_DELETION, {}, { token: me.token });
    const token = await linkFrom(me.email, 'delete');
    await gql(CONFIRM_DELETION, { token });
    expect((await gql(CONFIRM_DELETION, { token })).data.profile.confirmAccountDeletion).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'token' }] });

    const other = await person('other');
    const expired = await jwt().issueToken('AccountDeletion', { sub: other.id, email: other.email, jti: crypto.randomUUID() }, { ttl: -60 });
    expect((await gql(CONFIRM_DELETION, { token: expired })).data.profile.confirmAccountDeletion).toMatchObject({
      status: 'error', userErrors: [{ fieldName: 'token', messages: ['This link is invalid or has expired. Please request a new one.'] }],
    });
    expect((await gql(USER, {}, { token: other.token })).data.user).toMatchObject({ email: other.email });
  });

  it('lets the email sign up again as a new account', async () => {
    const me = await person('me');
    await gql(REQUEST_DELETION, {}, { token: me.token });
    await gql(CONFIRM_DELETION, { token: await linkFrom(me.email, 'delete') });
    const again = await signInWithMagicLink(me.email);
    expect(again.id).not.toBe(me.id);
    expect((await gql(USER, {}, { token: again.token })).data.user).toEqual({ id: again.id, name: '', email: me.email });
  });
});

describe('changing the email', () => {
  it('needs a session to ask for the link', async () => {
    expect((await gql(REQUEST_CHANGE, { email: uniqueEmail() })).errors?.[0]?.message).toBe('UNAUTHENTICATED');
  });

  it('mails a link to the new address and a notice to the old one; confirming moves the account', async () => {
    const me = await person('me');
    await gql(`mutation { profile { updateName(input: { name: "Moroz" }) { status } } }`, {}, { token: me.token });
    const newEmail = uniqueEmail('new');
    expect((await gql(REQUEST_CHANGE, { email: newEmail }, { token: me.token })).data.profile.requestEmailChange).toEqual({ status: 'ok', userErrors: null });
    const notice = (await mailbox(me.email)).at(-1)!;
    expect(notice.text).toContain(newEmail);
    expect(notice.text).not.toMatch(/profile\/email/);

    const res = (await gql(CONFIRM_CHANGE, { token: await linkFrom(newEmail, 'email') })).data.profile.confirmEmailChange;
    expect(res).toMatchObject({ status: 'ok', userErrors: null, user: { id: me.id, name: 'Moroz', email: newEmail } });
    expect(await jwt().jwtVerify<UserToken>(res.userToken, 'UserToken')).toMatchObject({ sub: me.id, email: newEmail, ver: 1 });

    expect((await gql(USER, {}, { token: res.userToken })).data.user).toEqual({ id: me.id, name: 'Moroz', email: newEmail });
    expect((await gql(USER, {}, { token: me.token })).data.user).toBeNull();
    // Signing in with the new address finds the same account.
    expect((await signInWithMagicLink(newEmail)).id).toBe(me.id);
  });

  it('moves open parties to the new email and leaves finished ones on the old one, all still listed', async () => {
    const host = await person('host');
    const me = await person('me');
    const other = await person('other');
    const open = await createParty(host, 'Open');
    await joinParty(me, open, 'Me');
    await joinParty(other, open, 'Other');
    const finished = await createParty(host, 'Finished');
    await joinParty(me, finished, 'Me');
    await closeParty(host, finished);
    await settleParty(finished.code);

    // An update for me queued in the open party before the change (say, waiting for a retry).
    await runInDurableObject(env.PARTY.getByName(open.code), async (_i, state) => {
      state.storage.sql.exec('INSERT INTO outbox (payload, next_attempt_at) VALUES (?, ?)', JSON.stringify({ kind: 'user.sync', email: me.email }), Date.now() + 60_000);
    });

    const newEmail = uniqueEmail('moved');
    await gql(REQUEST_CHANGE, { email: newEmail }, { token: me.token });
    const { userToken } = (await gql(CONFIRM_CHANGE, { token: await linkFrom(newEmail, 'email') })).data.profile.confirmEmailChange;
    const moved = { ...me, email: newEmail, token: userToken };

    expect(await memberEmail(open.code, rawId(me))).toBe(newEmail);
    expect(await memberEmail(finished.code, rawId(me))).toBe(me.email);
    expect((await gql(HISTORY, {}, { token: userToken })).data.partyHistory.items).toEqual(expect.arrayContaining([
      { code: open.code, isClosed: false }, { code: finished.code, isClosed: true },
    ]));
    expect((await gql(PARTY, { code: finished.code }, { token: userToken })).data.party).toMatchObject({ isJoined: true, target: expect.anything() });

    // The queued update now goes to the new address.
    await runInDurableObject(env.PARTY.getByName(open.code), async (_i, state) => {
      expect(JSON.parse(state.storage.sql.exec<{ payload: string }>('SELECT payload FROM outbox').one().payload)).toEqual({ kind: 'user.sync', email: newEmail });
      state.storage.sql.exec('UPDATE outbox SET next_attempt_at = 0');
      await state.storage.setAlarm(Date.now());
    });
    expect(await settleParty(open.code)).toBe(0);

    // And so do updates from now on: drawing the open party marks it closed in the new account's list and mails the new address.
    await closeParty(host, open);
    await settleParty(open.code);
    expect((await gql(HISTORY, {}, { token: moved.token })).data.partyHistory.items).toEqual(expect.arrayContaining([{ code: open.code, isClosed: true }]));
    expect((await mailbox(newEmail)).some(mail => mail.text?.includes(`/p/${open.code}/`))).toBe(true);
    expect((await mailbox(me.email)).some(mail => mail.text?.includes(`/p/${open.code}/`))).toBe(false);
  });

  it('lets the moved account leave an open party it joined under the old email', async () => {
    const host = await person('host');
    const me = await person('me');
    const open = await createParty(host, 'Open');
    await joinParty(me, open, 'Me');
    const newEmail = uniqueEmail('moved');
    await gql(REQUEST_CHANGE, { email: newEmail }, { token: me.token });
    const { userToken } = (await gql(CONFIRM_CHANGE, { token: await linkFrom(newEmail, 'email') })).data.profile.confirmEmailChange;
    expect((await gql(LEAVE_PARTY, { party: open.id }, { token: userToken })).data.parties.leaveParty).toMatchObject({ status: 'ok' });
    expect((await gql(HISTORY, {}, { token: userToken })).data.partyHistory.items).toEqual([]);
  });

  it('rejects a new address that is already taken, when asked and when confirming', async () => {
    const me = await person('me');
    const taken = await person('taken');
    expect((await gql(REQUEST_CHANGE, { email: taken.email }, { token: me.token })).data.profile.requestEmailChange).toEqual({
      status: 'error', userErrors: [{ fieldName: 'email', messages: ['This email is already used by another account.'] }],
    });

    const later = uniqueEmail('later');
    await gql(REQUEST_CHANGE, { email: later }, { token: me.token });
    const token = await linkFrom(later, 'email');
    await signInWithMagicLink(later);
    expect((await gql(CONFIRM_CHANGE, { token })).data.profile.confirmEmailChange).toMatchObject({
      status: 'error', userErrors: [{ fieldName: 'token', messages: ['This email is already used by another account.'] }], userToken: null,
    });
    expect((await gql(USER, {}, { token: me.token })).data.user).toMatchObject({ email: me.email });
  });

  it('refuses a replayed or expired link', async () => {
    const me = await person('me');
    const newEmail = uniqueEmail('new');
    await gql(REQUEST_CHANGE, { email: newEmail }, { token: me.token });
    const token = await linkFrom(newEmail, 'email');
    expect((await gql(CONFIRM_CHANGE, { token })).data.profile.confirmEmailChange.status).toBe('ok');
    expect((await gql(CONFIRM_CHANGE, { token })).data.profile.confirmEmailChange).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'token' }] });

    const other = await person('other');
    const expired = await jwt().issueToken('EmailChange', { sub: other.id, email: other.email, newEmail: uniqueEmail(), jti: crypto.randomUUID() }, { ttl: -60 });
    expect((await gql(CONFIRM_CHANGE, { token: expired })).data.profile.confirmEmailChange).toMatchObject({
      status: 'error', userErrors: [{ fieldName: 'token', messages: ['This link is invalid or has expired. Please request a new one.'] }],
    });
  });

  it('validates the new address and reports a failed delivery', async () => {
    const me = await person('me');
    expect((await gql(REQUEST_CHANGE, { email: 'nope' }, { token: me.token })).data.profile.requestEmailChange).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'email' }] });
    expect((await gql(REQUEST_CHANGE, { email: me.email.toUpperCase() }, { token: me.token })).data.profile.requestEmailChange).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'email' }] });
    expect((await gql(REQUEST_CHANGE, { email: uniqueEmail('fail+new') }, { token: me.token })).data.profile.requestEmailChange).toMatchObject({
      status: 'error', userErrors: [{ fieldName: 'email', messages: ["We couldn't send the email right now. Please try again in a few minutes."] }],
    });
    expect(nodeIdToStr({ kind: 'User', id: rawId(me) })).toBe(me.id);
  });
});
