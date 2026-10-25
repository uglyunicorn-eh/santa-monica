import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { newObjectId } from 'src/utils/ids';

let counter = 0;
const uniqueEmail = (label = 'acct') => `${label}-${Date.now().toString(36)}-${++counter}@example.com`;

type Person = { userId: string; userEmail: string };

async function signedIn(name = 'Person'): Promise<Person> {
  const email = uniqueEmail();
  const user = await env.USER.getByName(email).ensure(email);
  await env.USER.getByName(email).apply([{ type: 'setName', name }]);
  return { userId: user.id, userEmail: email };
}

const code = () => {
  const abc = 'QWERTYUIPASDFGHJKLZXCVBNMO';
  let n = ++counter + 5000;
  let s = '';
  for (let i = 0; i < 5; i++) {
    s += abc[n % abc.length];
    n = Math.floor(n / abc.length);
  }
  return s;
};

/** A party whose members are signed-in users (so their lists are kept), optionally drawn. */
async function partyOf(host: Person, guests: Person[], { closed = false } = {}) {
  const slug = code();
  const stub = env.PARTY.getByName(slug);
  const member = (ctx: Person, name: string) => ({ id: ctx.userId!, email: ctx.userEmail!, name });
  await stub.create({ id: newObjectId(), slug, name: `Party ${slug}`, password: null, host: member(host, 'Host') });
  for (const [i, guest] of guests.entries()) {
    await stub.join(member(guest, `Guest ${i}`), `Guest ${i}`, null);
  }
  if (closed) {
    await stub.close(host.userId!);
    await drain(slug);
  }
  return { slug, stub };
}

async function drain(slug: string) {
  const stub = env.PARTY.getByName(slug);
  for (let i = 0; i < 30 && await stub.pendingOutbox(); i++) {
    await runDurableObjectAlarm(stub);
  }
}



const slugsOf = async (email: string) => (await env.USER.getByName(email).listParties(50))!.map(p => p.slug).sort();

describe('UserDO account changes', () => {
  it('starts a change once per link, only for the same live account, with every party', async () => {
    const email = uniqueEmail();
    const stub = env.USER.getByName(email);
    const user = await stub.ensure(email);
    await stub.apply([{ type: 'addParty', party: { slug: 'QQQEA', name: 'P', createdAt: 1, isHost: true, isProtected: false, isClosed: false, closedAt: null } }]);
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec("INSERT INTO parties (slug, name, created_at) VALUES ('QQQEB', 'Old row', 2)");
    });
    const later = Date.now() + 60_000;

    expect(await stub.startAccountChange(newObjectId(), 'j1', later)).toEqual({ ok: false, reason: 'gone' });
    const started = await stub.startAccountChange(user.id, 'j1', later);
    expect(started).toMatchObject({ ok: true, user: { id: user.id } });
    expect((started as any).parties.sort()).toEqual(['QQQEA', 'QQQEB']);
    // Held while the change runs: no second change, no profile, no checked writes.
    expect(await stub.startAccountChange(user.id, 'j2', later)).toEqual({ ok: false, reason: 'busy' });
    expect(await stub.get()).toBeNull();
    expect(await stub.updateName('X', { userId: user.id })).toBeNull();
    expect(await stub.apply([{ type: 'setNameIfEmpty', name: 'Joiner', userId: user.id }], { userId: user.id })).toBeNull();
    expect(await stub.apply([{ type: 'removeParty', slug: 'QQQEB' }])).toMatchObject({ id: user.id });

    // Aborting releases the account and the link, which can be used again.
    await stub.abortAccountChange('j1');
    expect(await stub.get()).toMatchObject({ id: user.id, name: '' });
    expect(await stub.startAccountChange(user.id, 'j1', later)).toMatchObject({ ok: true, parties: ['QQQEA'] });

    // A hold that outlived its request runs out after a minute; a used link stays used.
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec('UPDATE user SET changing_until = ?', Date.now() - 1);
    });
    expect(await stub.get()).toMatchObject({ id: user.id });
    expect(await stub.startAccountChange(user.id, 'j1', later)).toEqual({ ok: false, reason: 'used' });

    await stub.tombstone();
    expect(await stub.startAccountChange(user.id, 'j3', later)).toEqual({ ok: false, reason: 'gone' });
    // A link that was used reads as used, even on the tombstone its change left behind.
    expect(await stub.startAccountChange(user.id, 'j1', later)).toEqual({ ok: false, reason: 'used' });
  });

  it('receives a moved account, refusing an address a live account uses', async () => {
    const taken = uniqueEmail('taken');
    await env.USER.getByName(taken).ensure(taken);
    const record = { id: newObjectId(), email: taken, name: 'Mover', joined: 5, tokenVersion: 1 };
    expect(await env.USER.getByName(taken).receive(record, [])).toBeNull();

    const fresh = uniqueEmail('fresh');
    const stub = env.USER.getByName(fresh);
    // A party already sending to the new address since its membership moved: its row is newer and is kept.
    await stub.apply([{ type: 'addParty', party: { slug: 'QQQFA', name: 'Newer', createdAt: 1, isHost: false, isProtected: false, isClosed: true, closedAt: null } }]);
    const moved = await stub.receive({ ...record, email: fresh }, [
      { slug: 'QQQFA', name: 'Older', createdAt: 1, isHost: false, isProtected: false, isClosed: false, closedAt: null },
      { slug: 'QQQFB', name: 'Copied', createdAt: 2, isHost: true, isProtected: true, isClosed: false, closedAt: null },
    ]);
    expect(moved).toEqual({ id: record.id, email: fresh, name: 'Mover', joined: 5, tokenVersion: 1 });
    expect(await stub.get()).toEqual(moved);
    expect(await stub.listParties(10)).toMatchObject([
      { slug: 'QQQFB', name: 'Copied', isHost: true },
      { slug: 'QQQFA', name: 'Newer', isClosed: true },
    ]);
  });

  it('keeps a tombstone\'s higher token version when receiving over it', async () => {
    const email = uniqueEmail('over');
    const stub = env.USER.getByName(email);
    await stub.ensure(email);
    await stub.tombstone();
    await stub.ensure(email);
    await stub.tombstone();
    expect(await stub.receive({ id: newObjectId(), email, name: '', joined: 1, tokenVersion: 1 }, [])).toMatchObject({ tokenVersion: 2 });
  });
});

describe('PartyDO.forgetMember', () => {
  it('deletes an open party the user hosts, whoever joined: gone at once, off every list, its code retired', async () => {
    const host = await signedIn('Host');
    const guest = await signedIn('Guest');
    const { slug, stub } = await partyOf(host, [guest]);
    await stub.join({ id: newObjectId(), email: null, name: 'Legacy' }, 'Legacy', null);

    expect(await stub.forgetMember(host.userId!, host.userEmail!)).toBe('deleted');
    expect(await stub.view(guest.userId)).toBeNull();
    expect(await stub.join({ id: newObjectId(), email: uniqueEmail(), name: 'Late' }, 'Late', null)).toMatchObject({ ok: false, error: { message: 'Party does not exist.' } });
    expect(await stub.leave(guest.userId!)).toMatchObject({ ok: false });
    expect(await stub.forgetMember(guest.userId!, guest.userEmail!)).toBe('none');

    await drain(slug);
    expect(await slugsOf(guest.userEmail!)).toEqual([]);
    expect(await stub.pendingOutbox()).toBe(0);
    // Like a cancelled party, its code is never handed out again.
    expect(await stub.create({ id: newObjectId(), slug, name: 'Reuse', password: null, host: { id: guest.userId!, email: guest.userEmail!, name: 'G' } })).toEqual({ ok: false, conflict: true });
  });

  it('deletes parties created before cancelling existed', async () => {
    const host = await signedIn('Host');
    const { stub } = await partyOf(host, []);
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec('DROP TABLE cancelled');
    });
    await evictDurableObject(stub);
    expect(await stub.forgetMember(host.userId!, host.userEmail!)).toBe('deleted');
    expect(await stub.view(host.userId)).toBeNull();
  });

  it('leaves an open party the user joined, and drops what was queued for them', async () => {
    const host = await signedIn('Host');
    const guest = await signedIn('Guest');
    const { slug, stub } = await partyOf(host, [guest]);
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec('INSERT INTO outbox (payload, next_attempt_at) VALUES (?, ?)', JSON.stringify({ kind: 'user.sync', email: guest.userEmail }), Date.now() + 60_000);
    });
    expect(await stub.forgetMember(guest.userId!, guest.userEmail!)).toBe('left');
    expect(await stub.pendingOutbox()).toBe(0);
    expect(await stub.view(host.userId)).toMatchObject({ participantCount: 1, participants: ['Host'] });
    expect(slug).toHaveLength(5);
  });

  it('anonymizes the user in a drawn party: new id everywhere, no email, names kept', async () => {
    const host = await signedIn('Host');
    const guest = await signedIn('Guest');
    const { stub } = await partyOf(host, [guest], { closed: true });
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec('INSERT INTO outbox (payload, next_attempt_at) VALUES (?, ?)', JSON.stringify({ kind: 'mail.partyNotification', email: guest.userEmail, partyName: 'P', slug: 'X' }), Date.now() + 60_000);
    });

    expect(await stub.forgetMember(guest.userId!, guest.userEmail!)).toBe('anonymized');
    expect(await stub.pendingOutbox()).toBe(0);
    expect(await stub.view(guest.userId)).toMatchObject({ isJoined: false, target: null });
    const hostView = (await stub.view(host.userId))!;
    expect(hostView.target!.name).toBe('Guest 0');
    expect(hostView.target!.id).not.toBe(guest.userId);
    await runInDurableObject(stub, async (_i, state) => {
      const rows = state.storage.sql.exec<{ member_id: string; member_email: string | null; name: string; target_id: string; target_name: string }>('SELECT * FROM memberships ORDER BY name').toArray();
      const anonymous = rows.find(r => r.name === 'Guest 0')!;
      expect(anonymous).toMatchObject({ member_email: null, target_name: 'Host' });
      expect(anonymous.member_id).toBe(hostView.target!.id);
      expect(rows.find(r => r.name === 'Host')!.target_id).toBe(anonymous.member_id);
    });

    // The host's own deletion also takes the host role off their old id.
    expect(await stub.forgetMember(host.userId!, host.userEmail!)).toBe('anonymized');
    expect(await stub.view(host.userId)).toMatchObject({ isHost: false, isJoined: false, password: null });
  });

  it('anonymizes the host of a drawn party they had left', async () => {
    const host = await signedIn('Host');
    const a = await signedIn('A');
    const b = await signedIn('B');
    const { stub } = await partyOf(host, [a, b]);
    await stub.leave(host.userId!);
    await stub.close(host.userId!);
    expect(await stub.forgetMember(host.userId!, host.userEmail!)).toBe('anonymized');
    expect(await stub.view(host.userId)).toMatchObject({ isHost: false });
  });

  it('does nothing for strangers and unknown parties', async () => {
    const host = await signedIn('Host');
    const stranger = await signedIn('Stranger');
    const open = await partyOf(host, []);
    const drawn = await partyOf(host, [await signedIn('G')], { closed: true });
    expect(await open.stub.forgetMember(stranger.userId!, stranger.userEmail!)).toBe('none');
    expect(await drawn.stub.forgetMember(stranger.userId!, stranger.userEmail!)).toBe('none');
    expect(await env.PARTY.getByName(code()).forgetMember(stranger.userId!, stranger.userEmail!)).toBe('none');
  });
});

describe('PartyDO.changeMemberEmail', () => {
  it('moves an open party\'s membership and queued updates to the new email', async () => {
    const host = await signedIn('Host');
    const guest = await signedIn('Guest');
    const { stub } = await partyOf(host, [guest]);
    const newEmail = uniqueEmail('moved');
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec('INSERT INTO outbox (payload, next_attempt_at) VALUES (?, ?)', JSON.stringify({ kind: 'user.sync', email: guest.userEmail }), Date.now() + 60_000);
    });
    expect(await stub.changeMemberEmail(guest.userId!, guest.userEmail!, newEmail)).toMatchObject({ isHost: false, isClosed: false });
    await runInDurableObject(stub, async (_i, state) => {
      expect(state.storage.sql.exec('SELECT member_email FROM memberships WHERE member_id = ?', guest.userId).one()).toEqual({ member_email: newEmail });
      expect(JSON.parse(state.storage.sql.exec<{ payload: string }>('SELECT payload FROM outbox').one().payload)).toEqual({ kind: 'user.sync', email: newEmail });
    });
  });

  it('keeps the old email in a drawn party, and returns null for non-members and unknown parties', async () => {
    const host = await signedIn('Host');
    const guest = await signedIn('Guest');
    const { stub } = await partyOf(host, [guest], { closed: true });
    expect(await stub.changeMemberEmail(guest.userId!, guest.userEmail!, uniqueEmail())).toMatchObject({ isClosed: true });
    await runInDurableObject(stub, async (_i, state) => {
      expect(state.storage.sql.exec('SELECT member_email FROM memberships WHERE member_id = ?', guest.userId).one()).toEqual({ member_email: guest.userEmail });
    });
    expect(await stub.changeMemberEmail(newObjectId(), 'x@example.com', 'y@example.com')).toBeNull();
    expect(await env.PARTY.getByName(code()).changeMemberEmail(guest.userId!, 'x@example.com', 'y@example.com')).toBeNull();
  });
});
