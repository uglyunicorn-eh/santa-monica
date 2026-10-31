import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { MAX_PARTY_INVITES, REINVITE_AFTER_MS } from 'src/do/PartyDO';
import { UserDO } from 'src/do/UserDO';

import {
  Person, ageRows, call, changeEmail, createParty, deleteAccount, drawParty, joinParty, mailbox, myParties, settleParty, signIn,
  uniqueEmail, viewParty,
} from './support';

// Plan section 1: keep less personal data. Each case goes through the Worker; storage is read only to show what's kept.

const DAY = 24 * 60 * 60 * 1000;

const invite = (host: Person, code: string, emails: string[]) =>
  call('POST', '/v1/parties/invite', { token: host.token, body: { code, emails } });

const partySql = <T>(code: string, query: string) =>
  runInDurableObject(env.PARTY.getByName(code), async (_i, state) => state.storage.sql.exec(query).toArray() as T[]);

const invitedAddresses = async (code: string) => (await partySql<{ email: string }>(code, 'SELECT email FROM invites')).map(r => r.email);

describe('invited addresses', () => {
  it('are kept for a day, then deleted when the host invites again', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host);
    const first = uniqueEmail('first');
    expect((await invite(host, party.code, [first])).body.invited).toEqual([first]);
    expect(await invitedAddresses(party.code)).toEqual([first]);

    await ageRows(env.PARTY.getByName(party.code), 'invites', 'invited_at', REINVITE_AFTER_MS + 1000);
    const second = uniqueEmail('second');
    await invite(host, party.code, [second]);
    expect(await invitedAddresses(party.code)).toEqual([second]);
  });

  it('are deleted by the alarm once a day has passed, with no other activity', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host);
    await invite(host, party.code, [uniqueEmail('quiet')]);
    await settleParty(party.code);
    await ageRows(env.PARTY.getByName(party.code), 'invites', 'invited_at', REINVITE_AFTER_MS + 1000);
    // The alarm set for when the invite is due to go is still there; run it now.
    expect(await runDurableObjectAlarm(env.PARTY.getByName(party.code))).toBe(true);
    expect(await invitedAddresses(party.code)).toEqual([]);
  });

  it('are skipped when repeated within a day, but every invite sent still counts towards the cap', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host);
    const guest = uniqueEmail('again');
    expect((await invite(host, party.code, [guest])).body).toMatchObject({ invited: [guest], invitesLeft: MAX_PARTY_INVITES - 1 });
    expect((await invite(host, party.code, [guest])).body).toMatchObject({ invited: [], alreadyInvited: [guest], invitesLeft: MAX_PARTY_INVITES - 1 });
    // A day later the address is forgotten, so it's invited again, and counted again.
    await ageRows(env.PARTY.getByName(party.code), 'invites', 'invited_at', REINVITE_AFTER_MS + 1000);
    expect((await invite(host, party.code, [guest])).body).toMatchObject({ invited: [guest], invitesLeft: MAX_PARTY_INVITES - 2 });
    expect(await partySql(party.code, 'SELECT invites_sent FROM party')).toEqual([{ invites_sent: 2 }]);
  });

  it('stop at the cap, counted from the counter rather than the kept rows', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host);
    await partySql(party.code, `UPDATE party SET invites_sent = ${MAX_PARTY_INVITES - 1}`);
    expect(await invite(host, party.code, [uniqueEmail('a'), uniqueEmail('b')])).toMatchObject({ status: 429, body: { error: { code: 'rate_limited', field: 'emails' } } });
    expect((await invite(host, party.code, [uniqueEmail('last')])).body.invitesLeft).toBe(0);
  });

  it('are all deleted when the party is drawn', async () => {
    const host = await signIn(uniqueEmail('host'));
    const guest = await signIn(uniqueEmail('guest'));
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');
    await invite(host, party.code, [uniqueEmail('never-came')]);
    expect(await invitedAddresses(party.code)).toHaveLength(1);
    expect((await drawParty(host, party)).status).toBe(200);
    expect(await invitedAddresses(party.code)).toEqual([]);
  });
});

describe("members' emails in a drawn party", () => {
  it('are cleared once the draw has been delivered, and everything still works by member id', async () => {
    const host = await signIn(uniqueEmail('host'));
    const guests = await Promise.all([signIn(uniqueEmail('g1')), signIn(uniqueEmail('g2'))]);
    const party = await createParty(host);
    for (const [i, guest] of guests.entries()) {
      await joinParty(guest, party, `Guest ${i}`);
    }
    await drawParty(host, party);
    await settleParty(party.code);
    expect(await partySql(party.code, 'SELECT member_email FROM memberships WHERE member_email IS NOT NULL')).toEqual([]);
    // The draw emails went out before the addresses were dropped (to the guests: the host just rolled).
    for (const person of guests) {
      expect((await mailbox(person.email)).some(m => m.text?.includes(party.code))).toBe(true);
    }

    // Views, lists, an email change and an account deletion still find the members.
    for (const person of [host, ...guests]) {
      expect((await viewParty(party.code, person)).body).toMatchObject({ isJoined: true, target: expect.anything() });
      expect((await myParties(person)).body.items.map(p => p.code)).toContain(party.code);
    }
    const moved = await changeEmail(guests[0], uniqueEmail('moved'));
    expect((await viewParty(party.code, moved)).body.target).not.toBeNull();
    await deleteAccount(guests[1]);
    expect((await viewParty(party.code, host)).body).toMatchObject({ isClosed: true, participantCount: 3 });
  });

  it('are kept while anything is still waiting in the outbox', async () => {
    const host = await signIn(uniqueEmail('host'));
    const guest = await signIn(uniqueEmail('guest'));
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');
    // Something that waits for a retry an hour from now, as a failed delivery would.
    await partySql(party.code, `INSERT INTO outbox (payload, next_attempt_at) VALUES ('{"kind":"user.sync","email":"${uniqueEmail('waiting')}"}', ${Date.now() + 60 * 60 * 1000})`);
    await drawParty(host, party);
    await settleParty(party.code, 3);
    expect(await partySql(party.code, 'SELECT member_email FROM memberships WHERE member_email IS NOT NULL')).toHaveLength(2);
    // Once it's gone, the next run clears them.
    await partySql(party.code, 'DELETE FROM outbox');
    await runDurableObjectAlarm(env.PARTY.getByName(party.code));
    expect(await partySql(party.code, 'SELECT member_email FROM memberships WHERE member_email IS NOT NULL')).toEqual([]);
  });
});

describe('a deleted account', () => {
  it('keeps no email in its tombstone, and the address can sign up again as a new account', async () => {
    const who = await signIn(uniqueEmail('leaving'));
    await deleteAccount(who);
    const kept = await runInDurableObject(env.USER.getByName(who.email), async (_i: UserDO, state) =>
      state.storage.sql.exec<{ email: string; name: string }>('SELECT email, name FROM user').toArray());
    expect(kept).toEqual([{ email: '', name: '' }]);
    const again = await signIn(who.email);
    expect(again.id).not.toBe(who.id);
  });
});

describe('expired link records', () => {
  it('are deleted when the user object starts', async () => {
    const who = await signIn(uniqueEmail('old-links'));
    const stub = env.USER.getByName(who.email);
    await ageRows(stub, 'used_magic_links', 'expires_at', 2 * DAY);
    // A test can't restart an object, so this runs the start-up clean-up the constructor runs.
    const left = await runInDurableObject(stub, async (instance: UserDO, state) => {
      (instance as any).forgetExpired();
      return state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM used_magic_links').one().n;
    });
    expect(left).toBe(0);
  });
});
