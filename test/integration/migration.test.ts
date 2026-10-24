import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { ImportSnapshot } from 'src/do/types';
import { nodeIdToStr } from 'src/utils/strings/nodeId';

import { JOIN_PARTY, PARTIES, PARTY, api, gql, settleParty, signInWithMagicLink, uniqueEmail } from './support';

const hex = (c: string) => c.repeat(24);

/**
 * A small snapshot shaped like the real export: a closed party (with a legacy member who has no email and so no
 * account), and an open protected party that keeps going after the migration.
 */
function fixture(): { snapshot: ImportSnapshot; alice: string; bob: string } {
  const alice = uniqueEmail('alice');
  const bob = uniqueEmail('bob');
  const [A, B, L] = [hex('a'), hex('b'), hex('c')];
  return {
    alice,
    bob,
    snapshot: {
      users: [
        { id: A, email: alice, name: 'Alice', joined: 1_576_000_000_000, parties: [{ slug: 'KLJHG', name: 'Xmas 2023', createdAt: 1_700_000_000_000 }, { slug: 'MNBVX', name: 'Xmas 2024', createdAt: 1_730_000_000_000 }] },
        { id: B, email: bob, name: 'Bob', joined: 1_576_000_000_000, parties: [{ slug: 'KLJHG', name: 'Xmas 2023', createdAt: 1_700_000_000_000 }] },
      ],
      parties: [
        {
          id: hex('d'), slug: 'KLJHG', name: 'Xmas 2023', password: null, hostId: A, isClosed: true, createdAt: 1_700_000_000_000,
          members: [
            { id: A, email: alice, name: 'Alice', targetId: B, targetName: 'Bob', joinedAt: 1 },
            { id: B, email: bob, name: 'Bob', targetId: L, targetName: 'Legacy Larry', joinedAt: 2 },
            { id: L, email: null, name: 'Legacy Larry', targetId: A, targetName: 'Alice', joinedAt: 3 },
          ],
        },
        {
          id: hex('e'), slug: 'MNBVX', name: 'Xmas 2024', password: 'Snow', hostId: A, isClosed: false, createdAt: 1_730_000_000_000,
          members: [{ id: A, email: alice, name: 'Alice', targetId: null, targetName: null, joinedAt: 4 }],
        },
      ],
    },
  };
}

const importSnapshot = (snapshot: ImportSnapshot, secret: string | null = env.ADMIN_SECRET!) => api('/admin/import', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(secret ? { 'x-admin-secret': secret } : {}) },
  body: JSON.stringify(snapshot),
});

describe('data migration', () => {
  it('hides the import endpoint without the right secret', async () => {
    const { snapshot } = fixture();
    expect((await importSnapshot(snapshot, null)).status).toBe(404);
    expect((await importSnapshot(snapshot, 'wrong')).status).toBe(404);
  });

  it('imports the snapshot and reports what it imported, the same on every run', async () => {
    const { snapshot } = fixture();
    const expected = { status: 'ok', imported: { users: 2, userParties: 3, parties: 2, memberships: 4 } };
    expect(await (await importSnapshot(snapshot)).json()).toEqual(expected);
    expect(await (await importSnapshot(snapshot)).json()).toEqual(expected);
  });

  it('lets imported people sign in and find their parties, names and draws', async () => {
    const { snapshot, alice, bob } = fixture();
    await importSnapshot(snapshot);

    const a = await signInWithMagicLink(alice.toUpperCase());
    expect(a.id).toBe(nodeIdToStr({ kind: 'User', id: hex('a') }));
    expect((await gql('{ user { name } }', {}, { token: a.token })).data.user.name).toBe('Alice');
    expect((await gql(PARTIES, {}, { token: a.token })).data.parties).toEqual([
      { code: 'MNBVX', name: 'Xmas 2024', isHost: true, isJoined: true },
      { code: 'KLJHG', name: 'Xmas 2023', isHost: true, isJoined: true },
    ]);

    const closedForAlice = (await gql(PARTY, { code: 'KLJHG' }, { token: a.token })).data.party;
    expect(closedForAlice).toMatchObject({
      isClosed: true, participantCount: 3, participants: ['Alice', 'Bob', 'Legacy Larry'],
      target: { id: nodeIdToStr({ kind: 'User', id: hex('b') }), name: 'Bob' },
    });

    const b = await signInWithMagicLink(bob);
    const closedForBob = (await gql(PARTY, { code: 'KLJHG' }, { token: b.token })).data.party;
    expect(closedForBob.target).toEqual({ id: nodeIdToStr({ kind: 'User', id: hex('c') }), name: 'Legacy Larry' });
  });

  it('keeps open parties working: new people can join with the old secret phrase', async () => {
    const { snapshot, alice } = fixture();
    await importSnapshot(snapshot);

    const newcomer = await signInWithMagicLink(uniqueEmail('newcomer'));
    const joined = await gql(JOIN_PARTY, { party: nodeIdToStr({ kind: 'Party', id: 'MNBVX' }), name: 'Newcomer', password: 'snow' }, { token: newcomer.token });
    expect(joined.data.parties.joinParty).toMatchObject({ status: 'ok', node: { participantCount: 2 } });
    expect(await settleParty('MNBVX')).toBe(0);

    const a = await signInWithMagicLink(alice);
    const hostView = (await gql(PARTY, { code: 'MNBVX' }, { token: a.token })).data.party;
    expect(hostView).toMatchObject({ password: 'Snow', participants: ['Alice', 'Newcomer'] });
  });
});
