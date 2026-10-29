import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { UserToken } from 'src/api/types';
import { strToNodeId } from 'src/utils/strings/nodeId';

import {
  Person, apiError, call, mintUserToken, changeEmail, confirmDeletion, confirmEmailChange, createParty, deleteAccount, drawParty, joinParty, jwt,
  leaveParty, linkToken, mailbox, me, myParties, newKey, requestDeletion, requestEmailChange, settleParty, signIn,
  uniqueEmail, viewParty,
} from './support';

const person = (label: string) => signIn(uniqueEmail(label));

const memberEmail = (code: string, userId: string) =>
  runInDurableObject(env.PARTY.getByName(code), async (_i, state) =>
    state.storage.sql.exec<{ member_email: string | null }>('SELECT member_email FROM memberships WHERE member_id = ?', userId).toArray()[0]?.member_email);

const rawId = (who: Person) => strToNodeId(who.id).id;

describe('deleting an account', () => {
  it('needs a session to ask for the link', async () => {
    expect((await call('POST', '/v1/me/deletion')).status).toBe(401);
  });

  it('emails a link that deletes the account: hosted open parties go, joined ones are left, drawn ones keep the draw', async () => {
    const who = await person('me');
    const friend = await person('friend');
    const other = await person('other');
    const mine = await createParty(who, 'Mine');
    await joinParty(friend, mine, 'Friend');
    const theirs = await createParty(friend, 'Theirs');
    await joinParty(who, theirs, 'Me');
    const drawn = await createParty(friend, 'Drawn');
    await joinParty(who, drawn, 'Me in drawn');
    await joinParty(other, drawn, 'Other');
    await drawParty(friend, drawn);

    const token = await requestDeletion(who);
    // The link works on its own, without a session.
    expect(await confirmDeletion(token)).toEqual({ status: 200, body: { ok: true } });

    expect((await me(who)).status).toBe(401);
    expect((await viewParty(mine.code, friend)).status).toBe(404);
    expect(await joinParty(other, mine, 'Late')).toMatchObject({ status: 404, body: apiError('not_found', 'Party does not exist.', 'party') });
    expect((await viewParty(theirs.code, friend)).body).toMatchObject({ participantCount: 1, participants: ['Friend'] });

    // In the drawn party the names stay, so whoever drew me still knows who to buy for.
    expect((await viewParty(drawn.code, friend)).body.participants).toEqual(['Friend', 'Me in drawn', 'Other']);
    expect(await memberEmail(drawn.code, rawId(who))).toBeUndefined();

    await settleParty(mine.code);
    expect((await myParties(friend)).body.items.map(p => p.code).sort()).toEqual([theirs.code, drawn.code].sort());

    // And a last email says it's done (sent by the account's alarm).
    let farewell: string[] = [];
    for (let i = 0; i < 50 && farewell.length === 0; i++) {
      farewell = (await mailbox(who.email)).map(m => m.subject).filter(s => s === 'Your Anonymous Santa Clauses account is deleted');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(farewell).toHaveLength(1);
  });

  it('sends one link for a repeated request, and answers a repeated confirmation the same', async () => {
    const who = await person('me');
    const key = newKey();
    await requestDeletion(who, key);
    const token = await requestDeletion(who, key);
    expect((await mailbox(who.email)).filter(m => m.text?.includes('/profile/delete#'))).toHaveLength(1);

    const confirmKey = newKey();
    expect(await confirmDeletion(token, { key: confirmKey })).toEqual({ status: 200, body: { ok: true } });
    expect(await confirmDeletion(token, { key: confirmKey })).toEqual({ status: 200, body: { ok: true } });
    expect(await confirmDeletion(token, { key: newKey() })).toMatchObject({ status: 409, body: apiError('link_used') });
  });

  it('refuses a replayed or expired link', async () => {
    const who = await person('me');
    const token = await requestDeletion(who);
    await confirmDeletion(token);
    // Says the link was used, though the account it deleted is gone by now.
    expect(await confirmDeletion(token)).toEqual({
      status: 409, body: apiError('link_used', 'This link has already been used. Please request a new one.', 'token'),
    });

    const other = await person('other');
    const expired = await jwt().issueToken('AccountDeletion', { sub: other.id, email: other.email, jti: crypto.randomUUID() }, { ttl: -60 });
    expect(await confirmDeletion(expired)).toEqual({
      status: 400, body: apiError('invalid_link', 'This link is invalid or has expired. Please request a new one.', 'token'),
    });
    expect(await me(other)).toMatchObject({ status: 200, body: { email: other.email } });
  });

  it('rejects links that are of another kind or missing what identifies the user', async () => {
    const who = await person('me');
    const email = who.email;
    const sub = who.id;
    const tokens = [
      await jwt().issueToken('AccountDeletion', { sub, email }, { ttl: 60 }),
      await jwt().issueToken('AccountDeletion', { sub, jti: 'a' }, { ttl: 60 }),
      await jwt().issueToken('AccountDeletion', { sub: 'not-a-node-id', email, jti: 'a' }, { ttl: 60 }),
      await jwt().issueToken('AccountDeletion', { sub: btoa('Party:QWERT'), email, jti: 'a' }, { ttl: 60 }),
      await jwt().issueToken('AccountDeletion', { sub, email, jti: 'a' }),
      await jwt().issueToken<UserToken>('UserToken', { sub, email }, { ttl: 60 }),
    ];
    for (const token of tokens) {
      expect(await confirmDeletion(token)).toMatchObject({ status: 400, body: apiError('invalid_link') });
    }
  });

  it('holds the account while a change runs: no joining, no new parties, no second change', async () => {
    const host = await person('host');
    const who = await person('me');
    const open = await createParty(host, 'Open');
    await env.USER.getByName(who.email).startAccountChange(rawId(who), crypto.randomUUID(), Date.now() + 60_000);

    expect((await joinParty(who, open, 'Me')).status).toBe(401);
    expect((await call('POST', '/v1/parties', { token: who.token, body: { name: 'Nope' } })).status).toBe(401);
    expect((await call('POST', '/v1/me/deletion', { token: who.token })).status).toBe(401);
    const token = await jwt().issueToken('AccountDeletion', { sub: who.id, email: who.email, jti: crypto.randomUUID(), ver: 0 }, { ttl: 60 });
    expect(await confirmDeletion(token)).toEqual({
      status: 409, body: apiError('account_busy', 'Another change to this account is in progress. Please try again in a minute.', 'token'),
    });
    expect((await viewParty(open.code, host)).body.participantCount).toBe(1);
  });

  it('says the account no longer exists for an unused link to a deleted account', async () => {
    const who = await person('me');
    const first = await requestDeletion(who);
    const second = await requestDeletion(who);
    expect(second).not.toBe(first);
    const change = await requestEmailChange(who, uniqueEmail('never'));

    expect((await confirmDeletion(first)).status).toBe(200);
    const gone = { status: 400, body: apiError('invalid_link', 'This account no longer exists.', 'token') };
    expect(await confirmDeletion(second)).toEqual(gone);
    expect(await confirmEmailChange(change)).toEqual(gone);
  });

  it('lets the email sign up again as a new account', async () => {
    const who = await person('me');
    await deleteAccount(who);
    const again = await signIn(who.email);
    expect(again.id).not.toBe(who.id);
    expect(await me(again)).toEqual({ status: 200, body: { id: again.id, name: '', email: who.email, joinedAt: expect.any(String), parties: { joined: 0, rolled: 0, hosted: 0 } } });
  });
});

describe('changing the email', () => {
  it('needs a session to ask for the link', async () => {
    expect((await call('POST', '/v1/me/email-change', { body: { email: uniqueEmail() } })).status).toBe(401);
  });

  it('mails a link to the new address and a notice to the old one; confirming moves the account', async () => {
    const who = await person('me');
    await call('PATCH', '/v1/me', { token: who.token, body: { name: 'Claus' } });
    const newEmail = uniqueEmail('new');
    const token = await requestEmailChange(who, newEmail);
    const notice = (await mailbox(who.email)).at(-1)!;
    expect(notice.text).toContain(newEmail);
    // The notice has only the link that cancels the change, never the one that confirms it.
    expect(notice.text).not.toContain('/profile/email#');
    expect(linkToken(notice, 'profile/email/cancel')).toBeTruthy();

    const res = await confirmEmailChange(token);
    expect(res).toMatchObject({ status: 200, body: { user: { id: who.id, name: 'Claus', email: newEmail } } });
    expect(await jwt().jwtVerify<UserToken>(res.body.userToken, 'UserToken')).toMatchObject({ sub: who.id, email: newEmail, ver: 1 });

    expect(await me({ token: res.body.userToken })).toEqual({ status: 200, body: { id: who.id, name: 'Claus', email: newEmail, joinedAt: expect.any(String), parties: { joined: 0, rolled: 0, hosted: 0 } } });
    expect((await me(who)).status).toBe(401);
    // Signing in with the new address finds the same account.
    expect((await signIn(newEmail)).id).toBe(who.id);
  });

  it('sends one link for a repeated request, and signs in again on a repeated confirmation', async () => {
    const who = await person('me');
    const newEmail = uniqueEmail('new');
    const key = newKey();
    await requestEmailChange(who, newEmail, key);
    const token = await requestEmailChange(who, newEmail, key);
    expect(await mailbox(newEmail)).toHaveLength(1);

    const confirmKey = newKey();
    const first = await confirmEmailChange(token, { key: confirmKey });
    const again = await confirmEmailChange(token, { key: confirmKey });
    expect(again.status).toBe(200);
    expect(again.body.user).toEqual(first.body.user);
    expect(await me({ token: again.body.userToken })).toMatchObject({ status: 200, body: { email: newEmail } });
    expect(await confirmEmailChange(token, { key: newKey() })).toMatchObject({ status: 409, body: apiError('link_used') });
  });

  it('treats the same key for another address as a new request', async () => {
    const who = await person('me');
    const key = newKey();
    const [one, two] = [uniqueEmail('one'), uniqueEmail('two')];
    await requestEmailChange(who, one, key);
    await requestEmailChange(who, two, key);
    expect([(await mailbox(one)).length, (await mailbox(two)).length]).toEqual([1, 1]);
  });

  it('moves open parties to the new email, leaves finished ones alone (their emails are already gone), all still listed', async () => {
    const host = await person('host');
    const who = await person('me');
    const other = await person('other');
    const open = await createParty(host, 'Open');
    await joinParty(who, open, 'Me');
    await joinParty(other, open, 'Other');
    const finished = await createParty(host, 'Finished');
    await joinParty(who, finished, 'Me');
    await drawParty(host, finished);
    await settleParty(finished.code);

    // An update for me queued in the open party before the change (say, waiting for a retry).
    await runInDurableObject(env.PARTY.getByName(open.code), async (_i, state) => {
      state.storage.sql.exec('INSERT INTO outbox (payload, next_attempt_at) VALUES (?, ?)', JSON.stringify({ kind: 'user.sync', email: who.email }), Date.now() + 60_000);
    });

    const newEmail = uniqueEmail('moved');
    const { body: { userToken } } = await confirmEmailChange(await requestEmailChange(who, newEmail));
    const moved = { ...who, email: newEmail, token: userToken };

    expect(await memberEmail(open.code, rawId(who))).toBe(newEmail);
    // A drawn party let go of its members' emails once the draw was delivered.
    expect(await memberEmail(finished.code, rawId(who))).toBeNull();
    expect((await myParties(moved)).body.items.map(p => ({ code: p.code, isClosed: p.isClosed }))).toEqual(expect.arrayContaining([
      { code: open.code, isClosed: false }, { code: finished.code, isClosed: true },
    ]));
    expect((await viewParty(finished.code, moved)).body).toMatchObject({ isJoined: true, target: expect.anything() });

    // The queued update now goes to the new address.
    await runInDurableObject(env.PARTY.getByName(open.code), async (_i, state) => {
      expect(JSON.parse(state.storage.sql.exec<{ payload: string }>('SELECT payload FROM outbox').one().payload)).toEqual({ kind: 'user.sync', email: newEmail });
      state.storage.sql.exec('UPDATE outbox SET next_attempt_at = 0');
      await state.storage.setAlarm(Date.now());
    });
    expect(await settleParty(open.code)).toBe(0);

    // And so do updates from now on: drawing the open party marks it closed in the new account's list and mails the new address.
    await drawParty(host, open);
    await settleParty(open.code);
    expect((await myParties(moved)).body.items.map(p => ({ code: p.code, isClosed: p.isClosed }))).toEqual(expect.arrayContaining([{ code: open.code, isClosed: true }]));
    expect((await mailbox(newEmail)).some(mail => mail.text?.includes(`/p/${open.code}/`))).toBe(true);
    expect((await mailbox(who.email)).some(mail => mail.text?.includes(`/p/${open.code}/`))).toBe(false);
  });

  it('lets the moved account leave an open party it joined under the old email', async () => {
    const host = await person('host');
    const who = await person('me');
    const open = await createParty(host, 'Open');
    await joinParty(who, open, 'Me');
    const { body: { userToken } } = await confirmEmailChange(await requestEmailChange(who, uniqueEmail('moved')));
    expect((await leaveParty({ token: userToken }, open)).status).toBe(200);
    expect((await myParties({ token: userToken })).body.items).toEqual([]);
  });

  it("doesn't tell whether an address is taken when asked, and refuses a taken one when confirming", async () => {
    const who = await person('me');
    const taken = await person('taken');
    const before = (await mailbox(taken.email)).length;
    expect(await call('POST', '/v1/me/email-change', { token: who.token, body: { email: taken.email } })).toEqual({ status: 202, body: { ok: true } });
    const notice = (await mailbox(taken.email)).slice(before);
    expect(notice.map(m => m.subject)).toEqual(['Someone tried to use your email on Anonymous Santa Clauses']);
    expect(notice[0].text).not.toMatch(/https?:/);
    expect(await me(taken)).toMatchObject({ status: 200, body: { email: taken.email } });

    const later = uniqueEmail('later');
    const token = await requestEmailChange(who, later);
    await signIn(later);
    expect(await confirmEmailChange(token)).toEqual({
      status: 409, body: apiError('conflict', 'This email is already used by another account.', 'token'),
    });
    expect(await me(who)).toMatchObject({ status: 200, body: { email: who.email } });
  });

  it('refuses a replayed or expired link', async () => {
    const who = await person('me');
    const token = await requestEmailChange(who, uniqueEmail('new'));
    expect((await confirmEmailChange(token)).status).toBe(200);
    // Says the link was used, though the old account is a tombstone by now.
    expect(await confirmEmailChange(token)).toEqual({
      status: 409, body: apiError('link_used', 'This link has already been used. Please request a new one.', 'token'),
    });

    const other = await person('other');
    const expired = await jwt().issueToken('EmailChange', { sub: other.id, email: other.email, newEmail: uniqueEmail(), jti: crypto.randomUUID() }, { ttl: -60 });
    expect(await confirmEmailChange(expired)).toEqual({
      status: 400, body: apiError('invalid_link', 'This link is invalid or has expired. Please request a new one.', 'token'),
    });
    const noNewEmail = await jwt().issueToken('EmailChange', { sub: other.id, email: other.email, jti: crypto.randomUUID() }, { ttl: 60 });
    expect((await confirmEmailChange(noNewEmail)).status).toBe(400);
  });

  it('validates the new address and reports a failed delivery, freeing the request', async () => {
    const who = await person('me');
    const ask = (email: string, key?: string) => call('POST', '/v1/me/email-change', { token: who.token, key, body: { email } });
    expect(await ask('nope')).toMatchObject({ status: 400, body: apiError('invalid', undefined, 'email') });
    expect(await ask(who.email.toUpperCase())).toEqual({ status: 400, body: apiError('invalid', "That's already your email.", 'email') });
    const key = newKey();
    const failing = uniqueEmail('fail+new');
    for (let i = 0; i < 2; i++) {
      expect(await ask(failing, key)).toEqual({
        status: 503, body: apiError('unavailable', "We couldn't send the email right now. Please try again in a few minutes.", 'email'),
      });
    }
  });

});

describe('"This wasn\'t me" on an email change', () => {
  it('stops the change, signs out everywhere, and the email stays', async () => {
    const who = await person('me');
    const other = await call('POST', '/v1/me/email-change', { token: who.token, body: { email: uniqueEmail('other') } });
    expect(other.status).toBe(202);
    const pending = await requestEmailChange(who, uniqueEmail('new'));
    const cancelLink = linkToken((await mailbox(who.email)).at(-1)!, 'profile/email/cancel');
    const key = newKey();

    expect(await call('POST', '/v1/me/email-change/cancel', { key, body: { token: cancelLink } })).toEqual({ status: 200, body: { ok: true } });
    expect(await call('POST', '/v1/me/email-change/cancel', { key, body: { token: cancelLink } })).toEqual({ status: 200, body: { ok: true } });
    expect((await confirmEmailChange(pending)).status).toBe(409);
    expect((await me(who)).status).toBe(401);

    // The owner signs in again with the same address and finds the same account.
    const again = await signIn(who.email);
    expect(again.id).toBe(who.id);
    expect(await me(again)).toMatchObject({ status: 200, body: { email: who.email } });
  });

  it('is too late once the change was confirmed', async () => {
    const who = await person('me');
    await changeEmail(who, uniqueEmail('moved'));
    const cancelLink = linkToken((await mailbox(who.email)).at(-1)!, 'profile/email/cancel');
    expect(await call('POST', '/v1/me/email-change/cancel', { body: { token: cancelLink } })).toEqual({
      status: 409, body: apiError('link_used', "The email was already changed. If this wasn't you, write to info@gnomik.me.", 'token'),
    });
  });
});

describe('signing out everywhere', () => {
  it('ends every session and voids pending account links; signing in again finds the same account', async () => {
    const who = await person('me');
    // A second device's session (made directly: the per-minute email limit leaves no room for another sign-in here).
    const laptop = { token: await mintUserToken({ sub: who.id, email: who.email, ver: 0 }) };
    expect((await me(laptop)).status).toBe(200);
    const deletion = await requestDeletion(who);
    expect(await call('POST', '/v1/me/sign-out', { token: who.token })).toEqual({ status: 200, body: { ok: true } });
    for (const token of [who.token, laptop.token]) {
      expect((await me({ token })).status).toBe(401);
    }
    expect(await confirmDeletion(deletion)).toMatchObject({ status: 400, body: { error: { code: 'invalid_link' } } });

    const again = await signIn(who.email);
    expect(again.id).toBe(who.id);
    expect((await me(again)).status).toBe(200);
  });
});

