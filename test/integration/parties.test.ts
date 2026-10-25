import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  apiError, call, createParty, deleteParty, drawParty, joinParty, leaveParty, myParties, newKey, restoreParty,
  settleParty, signIn, uniqueEmail, viewParty,
} from './support';

const person = (label: string) => signIn(uniqueEmail(label));
const codes = async (who: { token: string }) => (await myParties(who)).body.items.map(p => p.code);

describe('creating a party', () => {
  it('needs a session', async () => {
    expect(await call('POST', '/v1/parties', { body: { name: 'Nope' } })).toMatchObject({ status: 401, body: apiError('unauthenticated') });
  });

  it('validates the name', async () => {
    const host = await person('host');
    for (const name of ['   ', 'x'.repeat(101)]) {
      expect(await call('POST', '/v1/parties', { token: host.token, body: { name } })).toMatchObject({ status: 400, body: apiError('invalid', undefined, 'name') });
    }
  });

  it('makes the creator the host and first participant', async () => {
    const host = await person('host');
    const res = await call('POST', '/v1/parties', { token: host.token, body: { name: '  Office   party ', password: 'Jingle Bells' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Office party', isHost: true, isJoined: true, isClosed: false, isProtected: true,
      password: 'Jingle Bells', participantCount: 1, participants: [''], target: null,
    });
    expect(res.body.code).toMatch(/^[QWERTYUIPASDFGHJKLZXCVBNMO]{8}$/);
  });

  it('gives every party its own code', async () => {
    // A host per party: one person can only have three open at a time.
    const created = new Set<string>();
    for (let i = 0; i < 10; i++) {
      created.add((await createParty(await person(`host${i}`), `Party ${i}`)).code);
    }
    expect(created.size).toBe(10);
  });

  it('creates one party for a repeated request, holding one slot', async () => {
    const host = await person('host');
    const key = newKey();
    const first = await createParty(host, 'Once', null, key);
    const again = await createParty(host, 'Once', null, key);
    expect(again.code).toBe(first.code);
    expect(await codes(host)).toEqual([first.code]);
    // Two more slots are left, not one.
    await createParty(host, 'Two');
    await createParty(host, 'Three');
    expect((await call('POST', '/v1/parties', { token: host.token, body: { name: 'Four' } })).status).toBe(409);
  });

  it('treats the same key with another name as a new party', async () => {
    const host = await person('host');
    const key = newKey();
    const first = await createParty(host, 'One', null, key);
    const second = await createParty(host, 'Other', null, key);
    expect(second.code).not.toBe(first.code);
  });
});

describe('open-party limit, deleting and restoring', () => {
  it('caps a host at three open parties, and deleting one frees a slot', async () => {
    const host = await person('host');
    const parties = [];
    for (let i = 0; i < 3; i++) {
      parties.push(await createParty(host, `Party ${i}`));
    }
    const fourth = await call('POST', '/v1/parties', { token: host.token, body: { name: 'Fourth' } });
    expect(fourth).toMatchObject({ status: 409, body: { error: { code: 'conflict', message: expect.stringMatching(/up to 3 open parties/) } } });

    const deleted = await deleteParty(host, parties[0]);
    expect(deleted.status).toBe(200);
    expect(Date.parse(deleted.body.restorableUntil!) - Date.parse(deleted.body.deletedAt!)).toBe(24 * 60 * 60 * 1000);
    expect((await call('POST', '/v1/parties', { token: host.token, body: { name: 'Fourth' } })).status).toBe(201);

    // Back at three open parties, the deleted one can't come back until another goes.
    const refused = await restoreParty(host, parties[0]);
    expect(refused).toMatchObject({ status: 409, body: { error: { message: expect.stringMatching(/to restore this one/) } } });
  });

  it('hides a deleted party from its guests, and restoring brings it back for them', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');

    expect((await deleteParty(host, party)).status).toBe(200);
    expect((await viewParty(party.code, guest)).status).toBe(404);
    await expect.poll(() => codes(guest)).toEqual([]);
    expect(await codes(host)).toEqual([party.code]);

    expect(await restoreParty(host, party)).toMatchObject({ status: 200, body: { deletedAt: null } });
    expect((await viewParty(party.code, guest)).body).toMatchObject({ isJoined: true });
    await expect.poll(() => codes(guest)).toEqual([party.code]);
  });

  it('deletes and restores once: repeating either answers with the party as it is, holding no extra slot', async () => {
    const host = await person('host');
    const party = await createParty(host);
    const deleted = await deleteParty(host, party);
    expect(await deleteParty(host, party)).toEqual(deleted);

    const restored = await restoreParty(host, party);
    expect(restored).toMatchObject({ status: 200, body: { deletedAt: null } });
    expect(await restoreParty(host, party)).toEqual(restored);
    // One open party and two free slots.
    await createParty(host, 'Two');
    await createParty(host, 'Three');
    expect((await call('POST', '/v1/parties', { token: host.token, body: { name: 'Four' } })).status).toBe(409);
  });

  it('refuses to delete a party whose dice are rolled', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');
    expect((await drawParty(host, party)).status).toBe(200);
    expect(await deleteParty(host, party)).toMatchObject({ status: 409, body: apiError('conflict', undefined, 'party') });
    expect((await viewParty(party.code, guest)).body).toMatchObject({ isClosed: true });
  });

  it('lets only the host delete or restore, and a deleted party is invisible to others', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');
    expect(await deleteParty(guest, party)).toMatchObject({ status: 403, body: apiError('forbidden', undefined, 'party') });
    await deleteParty(host, party);
    expect(await deleteParty(guest, party)).toMatchObject({ status: 404 });
    expect(await restoreParty(guest, party)).toMatchObject({ status: 404 });
  });
});

describe('looking up a party', () => {
  it('shows a limited view to anyone with the code, in any case', async () => {
    const host = await person('host');
    const party = await createParty(host, 'Secret party', 'xyz');
    const anonymous = await viewParty(party.code.toLowerCase());
    expect(anonymous).toEqual({
      status: 200,
      body: {
        code: party.code, name: 'Secret party', password: null, isJoined: false, isHost: false, isProtected: true, isClosed: false,
        createdAt: party.createdAt, rolledAt: null, deletedAt: null, restorableUntil: null,
        participantCount: null, participants: null, target: null,
      },
    });
  });

  it('answers 404 for unknown or malformed codes', async () => {
    for (const code of ['QQQQQ', 'abc', '12345', 'QWERTYU']) {
      expect(await viewParty(code)).toEqual({ status: 404, body: apiError('not_found', 'Party does not exist.', 'party') });
    }
  });

  it('shows a non-member the same limited view as an anonymous visitor', async () => {
    const host = await person('host');
    const stranger = await person('stranger');
    const party = await createParty(host);
    expect((await viewParty(party.code, stranger)).body).toEqual((await viewParty(party.code)).body);
  });
});

describe('joining a party', () => {
  it('needs a session', async () => {
    const host = await person('host');
    const party = await createParty(host);
    expect((await call('POST', `/v1/parties/join?code=${party.code}`, { body: { name: 'Anon' } })).status).toBe(401);
  });

  it('checks the secret phrase, ignoring case', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host, 'Protected', 'Mistletoe');

    expect(await joinParty(guest, party, 'Guest')).toMatchObject({ status: 403, body: apiError('forbidden', undefined, 'password') });
    expect(await joinParty(guest, party, 'Guest', 'holly')).toMatchObject({ status: 403, body: apiError('forbidden', undefined, 'password') });
    expect(await joinParty(guest, party, 'Guest', 'mistletoe')).toMatchObject({
      status: 200, body: { isJoined: true, isHost: false, participantCount: 2, password: null },
    });
  });

  it('fills in an empty profile name from the name they joined with, and never overwrites it', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    const other = await createParty(host, 'Other party');
    await joinParty(guest, party, 'Santa\'s Helper');
    expect((await call('GET', '/v1/me', { token: guest.token })).body.name).toBe('Santa\'s Helper');

    await joinParty(guest, other, 'Elf');
    expect((await call('GET', '/v1/me', { token: guest.token })).body.name).toBe('Santa\'s Helper');
    expect((await viewParty(other.code, host)).body.participants).toEqual(['', 'Elf']);
  });

  it('is idempotent: joining twice keeps one membership', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');
    expect(await joinParty(guest, party, 'Guest again')).toMatchObject({ status: 200, body: { participantCount: 2 } });
  });

  it('answers 404 for codes that are not parties', async () => {
    const guest = await person('guest');
    expect(await joinParty(guest, { code: 'not-a-code' }, 'Guest')).toMatchObject({ status: 404, body: apiError('not_found', undefined, 'party') });
    expect(await joinParty(guest, { code: 'QQQQQ' }, 'Guest')).toMatchObject({ status: 404, body: apiError('not_found', 'Party does not exist.', 'party') });
  });

  it('validates the name', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    expect(await joinParty(guest, party, '')).toMatchObject({ status: 400, body: apiError('invalid', undefined, 'name') });
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

    const hostView = (await viewParty(party.code, host)).body;
    expect(hostView.participantCount).toBe(5);
    expect(hostView.participants).toEqual(['', 'Blitzen', 'Comet', 'Dasher', 'Vixen']);

    const guestView = (await viewParty(party.code, guests[0])).body;
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

    const listed = (await myParties(me)).body.items;
    expect(listed.map(p => [p.code, p.name, p.isHost, p.isJoined])).toEqual([
      [last.code, 'Last', true, true],
      [theirs.code, 'Theirs', false, true],
      [first.code, 'First', true, true],
    ]);
    expect((await myParties(me, '?first=2')).body.items.map(p => p.code)).toEqual([last.code, theirs.code]);
  });

  it('drops a party after leaving it', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');
    await leaveParty(guest, party);
    expect(await codes(guest)).toEqual([]);
  });

  it('needs a session', async () => {
    expect((await myParties({})).status).toBe(401);
  });
});

describe('leaving a party', () => {
  it('removes the membership and frees the spot', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');

    expect(await leaveParty(guest, party)).toMatchObject({ status: 200, body: { isJoined: false, participantCount: null } });
    expect((await viewParty(party.code, host)).body.participantCount).toBe(1);
  });

  it('is a no-op for someone who is not a member, and when repeated', async () => {
    const host = await person('host');
    const stranger = await person('stranger');
    const party = await createParty(host);
    expect(await leaveParty(stranger, party)).toMatchObject({ status: 200, body: { isJoined: false } });
    expect(await leaveParty(stranger, party)).toMatchObject({ status: 200, body: { isJoined: false } });
  });

  it('needs a session', async () => {
    const host = await person('host');
    const party = await createParty(host);
    expect((await call('POST', `/v1/parties/leave?code=${party.code}`)).status).toBe(401);
  });

  it('does not let the host leave their own party', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');
    expect(await leaveParty(host, party)).toMatchObject({ status: 409, body: apiError('conflict', undefined, 'party') });
    expect((await viewParty(party.code, host)).body).toMatchObject({ isHost: true, isJoined: true });
  });
});

describe('rolling the dice', () => {
  it('needs a session', async () => {
    const host = await person('host');
    const party = await createParty(host);
    expect((await call('POST', `/v1/parties/draw?code=${party.code}`)).status).toBe(401);
  });

  it('can only be done by the host', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');
    expect(await drawParty(guest, party)).toEqual({ status: 403, body: apiError('forbidden', 'You must be the host to close the party.', 'party') });
  });

  it('needs at least two participants', async () => {
    const host = await person('host');
    const party = await createParty(host);
    expect(await drawParty(host, party)).toMatchObject({ status: 409, body: apiError('conflict', undefined, 'party') });
  });
});

describe('party times', () => {
  const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
  const times = (p: { code: string; createdAt: string; rolledAt: string | null }) => ({ code: p.code, createdAt: p.createdAt, rolledAt: p.rolledAt });

  it('shows when a party started, and when its dice were rolled once the host closes it', async () => {
    const before = Date.now();
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host, 'Timed');
    await joinParty(guest, party, 'Guest');

    const open = (await viewParty(party.code)).body;
    expect(open.createdAt).toMatch(ISO);
    expect(Date.parse(open.createdAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(open.rolledAt).toBeNull();
    expect((await myParties(guest)).body.items.map(times)).toEqual([{ code: party.code, createdAt: open.createdAt, rolledAt: null }]);

    expect((await drawParty(host, party)).body.isClosed).toBe(true);
    const rolledAt = (await viewParty(party.code, guest)).body.rolledAt!;
    expect(rolledAt).toMatch(ISO);
    expect(Date.parse(rolledAt)).toBeGreaterThanOrEqual(Date.parse(open.createdAt));

    await settleParty(party.code);
    for (const p of [host, guest]) {
      expect((await myParties(p)).body.items.map(times)).toEqual([{ code: party.code, createdAt: open.createdAt, rolledAt }]);
    }
  });

  it('shows no roll time for a summary saved before roll times were kept', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host, 'Old');
    await joinParty(guest, party, 'Guest');
    await drawParty(host, party);
    await settleParty(party.code);
    await runInDurableObject(env.USER.getByName(guest.email), async (_i, state) => {
      state.storage.sql.exec('UPDATE parties SET closed_at = NULL');
    });
    const [item] = (await myParties(guest)).body.items;
    expect(item).toMatchObject({ code: party.code, createdAt: expect.stringMatching(ISO), rolledAt: null });
  });
});
