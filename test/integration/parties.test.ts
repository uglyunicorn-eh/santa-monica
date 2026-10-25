import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { nodeIdToStr } from 'src/utils/strings/nodeId';

import {
  CLOSE_PARTY, CREATE_PARTY, JOIN_PARTY, LEAVE_PARTY, PARTIES, PARTY, createParty, gql, joinParty,
  settleParty, signInWithMagicLink, uniqueEmail,
} from './support';

const person = (label: string) => signInWithMagicLink(uniqueEmail(label));

describe('creating a party', () => {
  it('needs a session', async () => {
    const res = await gql(CREATE_PARTY, { name: 'Nope' });
    expect(res.errors?.[0]?.message).toBe('UNAUTHENTICATED');
  });

  it('validates the name', async () => {
    const host = await person('host');
    const empty = await gql(CREATE_PARTY, { name: '   ' }, { token: host.token });
    expect(empty.data.parties.createParty).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'name' }] });

    const long = await gql(CREATE_PARTY, { name: 'x'.repeat(101) }, { token: host.token });
    expect(long.data.parties.createParty).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'name' }] });
  });

  it('makes the creator the host and first participant', async () => {
    const host = await person('host');
    const res = await gql(CREATE_PARTY, { name: '  Office   party ', password: 'Jingle Bells' }, { token: host.token });
    const party = res.data.parties.createParty.node;
    expect(party).toMatchObject({
      name: 'Office party', isHost: true, isJoined: true, isClosed: false, isProtected: true,
      password: 'Jingle Bells', participantCount: 1, participants: [''], target: null,
    });
    expect(party.code).toMatch(/^[QWERTYUIPASDFGHJKLZXCVBNMO]{8}$/);
    expect(party.id).toBe(nodeIdToStr({ kind: 'Party', id: party.code }));
  });

  it('gives every party its own code', async () => {
    // A host per party: one person can only have three open at a time.
    const codes = new Set<string>();
    for (let i = 0; i < 10; i++) {
      codes.add((await createParty(await person(`host${i}`), `Party ${i}`)).code);
    }
    expect(codes.size).toBe(10);
  });
});

describe('open-party limit, deleting and restoring', () => {
  const DELETE = `mutation ($party: ID!) { parties { deleteParty(input: { party: $party }) { status userErrors { fieldName messages } node { deletedAt restorableUntil } } } }`;
  const RESTORE = `mutation ($party: ID!) { parties { restoreParty(input: { party: $party }) { status userErrors { fieldName messages } node { deletedAt } } } }`;
  const codes = async (who: { token: string }) =>
    (await gql(PARTIES, {}, { token: who.token })).data.parties.map((p: { code: string }) => p.code);

  it('caps a host at three open parties, and deleting one frees a slot', async () => {
    const host = await person('host');
    const parties = [];
    for (let i = 0; i < 3; i++) {
      parties.push(await createParty(host, `Party ${i}`));
    }
    const fourth = await gql(CREATE_PARTY, { name: 'Fourth' }, { token: host.token });
    expect(fourth.data.parties.createParty.userErrors[0].messages[0]).toMatch(/up to 3 open parties/);

    const deleted = (await gql(DELETE, { party: parties[0].id }, { token: host.token })).data.parties.deleteParty;
    expect(deleted.status).toBe('ok');
    expect(Date.parse(deleted.node.restorableUntil) - Date.parse(deleted.node.deletedAt)).toBe(24 * 60 * 60 * 1000);
    expect((await gql(CREATE_PARTY, { name: 'Fourth' }, { token: host.token })).data.parties.createParty.status).toBe('ok');

    // Back at three open parties, the deleted one can't come back until another goes.
    const refused = (await gql(RESTORE, { party: parties[0].id }, { token: host.token })).data.parties.restoreParty;
    expect(refused.userErrors[0].messages[0]).toMatch(/to restore this one/);
  });

  it('hides a deleted party from its guests, and restoring brings it back for them', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');

    expect((await gql(DELETE, { party: party.id }, { token: host.token })).data.parties.deleteParty.status).toBe('ok');
    expect((await gql(PARTY, { code: party.code }, { token: guest.token })).data.party).toBeNull();
    await expect.poll(() => codes(guest)).toEqual([]);
    expect(await codes(host)).toEqual([party.code]);

    const restored = (await gql(RESTORE, { party: party.id }, { token: host.token })).data.parties.restoreParty;
    expect(restored).toMatchObject({ status: 'ok', node: { deletedAt: null } });
    expect((await gql(PARTY, { code: party.code }, { token: guest.token })).data.party).toMatchObject({ isJoined: true });
    await expect.poll(() => codes(guest)).toEqual([party.code]);
  });

  it('refuses to delete a party whose dice are rolled', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');
    expect((await gql(CLOSE_PARTY, { party: party.id }, { token: host.token })).data.parties.closeParty.status).toBe('ok');

    const res = await gql(DELETE, { party: party.id }, { token: host.token });
    expect(res.data.parties.deleteParty).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'party' }] });
    expect((await gql(PARTY, { code: party.code }, { token: guest.token })).data.party).toMatchObject({ isClosed: true });
  });

  it('lets only the host delete', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');
    const res = await gql(DELETE, { party: party.id }, { token: guest.token });
    expect(res.data.parties.deleteParty).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'party' }] });
  });
});

describe('looking up a party', () => {
  it('shows a limited view to anyone with the code, in any case', async () => {
    const host = await person('host');
    const party = await createParty(host, 'Secret party', 'xyz');
    const anonymous = await gql(PARTY, { code: party.code.toLowerCase() });
    expect(anonymous.data.party).toEqual({
      id: party.id, name: 'Secret party', code: party.code, password: null, isJoined: false, isHost: false,
      isProtected: true, isClosed: false, participantCount: null, participants: null, target: null,
    });
  });

  it('returns null for unknown or malformed codes', async () => {
    for (const code of ['QQQQQ', 'abc', '12345', '']) {
      expect((await gql(PARTY, { code })).data.party).toBeNull();
    }
  });

  it('shows a non-member the same limited view as an anonymous visitor', async () => {
    const host = await person('host');
    const stranger = await person('stranger');
    const party = await createParty(host);
    const view = (await gql(PARTY, { code: party.code }, { token: stranger.token })).data.party;
    expect(view).toMatchObject({ isJoined: false, isHost: false, participantCount: null, participants: null, password: null });
  });
});

describe('joining a party', () => {
  it('needs a session', async () => {
    const host = await person('host');
    const party = await createParty(host);
    const res = await gql(JOIN_PARTY, { party: party.id, name: 'Anon' });
    expect(res.errors?.[0]?.message).toBe('UNAUTHENTICATED');
  });

  it('checks the secret phrase, ignoring case', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host, 'Protected', 'Mistletoe');

    const missing = await joinParty(guest, party, 'Guest');
    expect(missing).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'password' }] });
    const wrong = await joinParty(guest, party, 'Guest', 'holly');
    expect(wrong).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'password' }] });

    const right = await joinParty(guest, party, 'Guest', 'mistletoe');
    expect(right).toMatchObject({ status: 'ok', node: { isJoined: true, isHost: false, participantCount: 2, password: null } });
  });

  it('fills in an empty profile name from the name they joined with, and never overwrites it', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    const other = await createParty(host, 'Other party');
    await joinParty(guest, party, 'Santa\'s Helper');
    expect((await gql('{ user { name } }', {}, { token: guest.token })).data.user.name).toBe('Santa\'s Helper');

    await joinParty(guest, other, 'Elf');
    expect((await gql('{ user { name } }', {}, { token: guest.token })).data.user.name).toBe('Santa\'s Helper');
    expect((await gql(PARTY, { code: other.code }, { token: host.token })).data.party.participants).toEqual(['', 'Elf']);
  });

  it('is idempotent: joining twice keeps one membership', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');
    const again = await joinParty(guest, party, 'Guest again');
    expect(again).toMatchObject({ status: 'ok', node: { participantCount: 2 } });
  });

  it('rejects ids that are not parties and parties that do not exist', async () => {
    const guest = await person('guest');
    const notAParty = await joinParty(guest, { id: guest.id }, 'Guest');
    expect(notAParty).toEqual({ status: 'error', userErrors: [{ fieldName: 'party', messages: ['Unknown input type. Must be Party.'] }], node: null });

    const garbage = await joinParty(guest, { id: 'not-a-node-id' }, 'Guest');
    expect(garbage).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'party' }] });

    const missing = await joinParty(guest, { id: nodeIdToStr({ kind: 'Party', id: 'QQQQQ' }) }, 'Guest');
    expect(missing).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'party', messages: ['Party does not exist.'] }] });
  });

  it('validates the name', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    const res = await gql(JOIN_PARTY, { party: party.id, name: '' }, { token: guest.token });
    expect(res.data.parties.joinParty).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'name' }] });
  });
});

describe('participants', () => {
  it('shows the host everyone, sorted, and others up to three people besides themselves', async () => {
    const host = await person('host');
    const party = await createParty(host);
    await joinParty(host, party, 'Zed');
    const guests = [];
    for (const name of ['Dasher', 'Comet', 'Blitzen', 'Vixen']) {
      const guest = await person('guest');
      await joinParty(guest, party, name);
      guests.push(guest);
    }

    const hostView = (await gql(PARTY, { code: party.code }, { token: host.token })).data.party;
    expect(hostView.participantCount).toBe(5);
    expect(hostView.participants).toEqual(['', 'Blitzen', 'Comet', 'Dasher', 'Vixen']);

    const guestView = (await gql(PARTY, { code: party.code }, { token: guests[0].token })).data.party;
    expect(guestView.participantCount).toBe(5);
    expect(guestView.participants).toHaveLength(3);
    expect(guestView.participants).not.toContain('Dasher');
  });
});

describe('my parties', () => {
  it('lists parties I host or joined, newest first, right after each change', async () => {
    const me = await person('me');
    const friend = await person('friend');
    const first = await createParty(me, 'First');
    const theirs = await createParty(friend, 'Theirs');
    await joinParty(me, theirs, 'Me');
    const last = await createParty(me, 'Last');

    const listed = (await gql(PARTIES, {}, { token: me.token })).data.parties;
    expect(listed).toEqual([
      { code: last.code, name: 'Last', isHost: true, isJoined: true },
      { code: theirs.code, name: 'Theirs', isHost: false, isJoined: true },
      { code: first.code, name: 'First', isHost: true, isJoined: true },
    ]);

    expect((await gql(PARTIES, { first: 2 }, { token: me.token })).data.parties.map((p: any) => p.code)).toEqual([last.code, theirs.code]);
    expect((await gql(PARTIES, { first: -1 }, { token: me.token })).data.parties).toEqual([]);
  });

  it('drops a party after leaving it', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');
    await gql(LEAVE_PARTY, { party: party.id }, { token: guest.token });
    expect((await gql(PARTIES, {}, { token: guest.token })).data.parties).toEqual([]);
  });

  it('is empty without a session', async () => {
    expect((await gql(PARTIES)).data.parties).toBeNull();
  });
});

describe('leaving a party', () => {
  it('removes the membership and frees the spot', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');

    const left = (await gql(LEAVE_PARTY, { party: party.id }, { token: guest.token })).data.parties.leaveParty;
    expect(left).toMatchObject({ status: 'ok', node: { isJoined: false, participantCount: null } });
    expect((await gql(PARTY, { code: party.code }, { token: host.token })).data.party.participantCount).toBe(1);
  });

  it('is a no-op for someone who is not a member', async () => {
    const host = await person('host');
    const stranger = await person('stranger');
    const party = await createParty(host);
    const res = (await gql(LEAVE_PARTY, { party: party.id }, { token: stranger.token })).data.parties.leaveParty;
    expect(res).toMatchObject({ status: 'ok', node: { isJoined: false } });
  });

  it('needs a session', async () => {
    const host = await person('host');
    const party = await createParty(host);
    expect((await gql(LEAVE_PARTY, { party: party.id })).errors?.[0]?.message).toBe('UNAUTHENTICATED');
  });

  it('does not let the host leave their own party', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');
    const left = (await gql(LEAVE_PARTY, { party: party.id }, { token: host.token })).data.parties.leaveParty;
    expect(left).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'party' }] });
    expect((await gql(PARTY, { code: party.code }, { token: host.token })).data.party).toMatchObject({ isHost: true, isJoined: true });
  });
});

describe('closing a party', () => {
  it('needs a session', async () => {
    const host = await person('host');
    const party = await createParty(host);
    expect((await gql(CLOSE_PARTY, { party: party.id })).errors?.[0]?.message).toBe('UNAUTHENTICATED');
  });

  it('can only be done by the host', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');
    const res = (await gql(CLOSE_PARTY, { party: party.id }, { token: guest.token })).data.parties.closeParty;
    expect(res).toEqual({ status: 'error', userErrors: [{ fieldName: 'party', messages: ['You must be the host to close the party.'] }], node: null });
  });

  it('needs at least two participants', async () => {
    const host = await person('host');
    const party = await createParty(host);
    const res = (await gql(CLOSE_PARTY, { party: party.id }, { token: host.token })).data.parties.closeParty;
    expect(res).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'party' }] });
  });
});

describe('party times', () => {
  const TIMES = `query ($code: String!) { party(code: $code) { createdAt rolledAt } }`;
  const HISTORY_TIMES = `{ partyHistory(first: 10) { items { code createdAt rolledAt } } }`;
  const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

  it('shows when a party started, and when its dice were rolled once the host closes it', async () => {
    const before = Date.now();
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host, 'Timed');
    await joinParty(guest, party, 'Guest');

    const open = (await gql(TIMES, { code: party.code })).data.party;
    expect(open.createdAt).toMatch(ISO);
    expect(Date.parse(open.createdAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(open.rolledAt).toBeNull();
    expect((await gql(HISTORY_TIMES, {}, { token: guest.token })).data.partyHistory.items).toEqual([
      { code: party.code, createdAt: open.createdAt, rolledAt: null },
    ]);

    const closed = (await gql(CLOSE_PARTY, { party: party.id }, { token: host.token })).data.parties.closeParty.node;
    expect(closed.isClosed).toBe(true);
    const rolledAt = (await gql(TIMES, { code: party.code }, { token: guest.token })).data.party.rolledAt;
    expect(rolledAt).toMatch(ISO);
    expect(Date.parse(rolledAt)).toBeGreaterThanOrEqual(Date.parse(open.createdAt));

    await settleParty(party.code);
    for (const p of [host, guest]) {
      expect((await gql(HISTORY_TIMES, {}, { token: p.token })).data.partyHistory.items).toEqual([
        { code: party.code, createdAt: open.createdAt, rolledAt },
      ]);
    }
  });

  it('shows no roll time for a summary saved before roll times were kept', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host, 'Old');
    await joinParty(guest, party, 'Guest');
    await gql(CLOSE_PARTY, { party: party.id }, { token: host.token });
    await settleParty(party.code);
    await runInDurableObject(env.USER.getByName(guest.email), async (_i, state) => {
      state.storage.sql.exec('UPDATE parties SET closed_at = NULL');
    });
    const [item] = (await gql(HISTORY_TIMES, {}, { token: guest.token })).data.partyHistory.items;
    expect(item).toMatchObject({ code: party.code, createdAt: expect.stringMatching(ISO), rolledAt: null });
  });
});
