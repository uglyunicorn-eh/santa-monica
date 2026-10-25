import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { newObjectId } from 'src/utils/ids';

import { drainOutbox, signIn } from './helpers';

const createParty = async (slug: string, host: { id: string; email: string; name: string }, password: string | null = null) => {
  return await env.PARTY.getByName(slug).create({ id: newObjectId(), slug, name: `Party ${slug}`, password, host });
};

describe('PartyDO', () => {
  it('creates a party and rejects a second create on the same slug', async () => {
    const host = await signIn('host1@example.com', 'Host');
    const first = await createParty('QWERT', host.member);
    expect(first.ok).toBe(true);
    if (!first.ok || 'conflict' in first) throw new Error('unexpected');
    expect(first.view).toMatchObject({ isHost: true, isJoined: true, participantCount: 1, participants: ['Host'] });

    const second = await createParty('QWERT', host.member);
    expect(second).toEqual({ ok: false, conflict: true });
  });

  it('returns null for an unknown party without creating storage', async () => {
    expect(await env.PARTY.getByName('ZZZZZ').view()).toBeNull();
  });

  it('checks the secret phrase case-insensitively', async () => {
    const host = await signIn('host2@example.com', 'Host');
    const guest = await signIn('guest2@example.com', 'Guest');
    await createParty('ASDFG', host.member, 'Jingle');

    const wrong = await env.PARTY.getByName('ASDFG').join(guest.member, 'Guest', 'nope');
    expect(wrong).toMatchObject({ ok: false, error: { fieldName: 'password' } });

    const right = await env.PARTY.getByName('ASDFG').join(guest.member, 'Guest', 'JINGLE');
    expect(right).toMatchObject({ ok: true, view: { isJoined: true, participantCount: 2, password: null, isProtected: true } });
  });

  it('closes a party with a valid draw and blocks join and leave afterwards', async () => {
    const host = await signIn('host3@example.com', 'Host');
    await createParty('ZXCVB', host.member);
    const guests = await Promise.all([1, 2, 3, 4].map(i => signIn(`guest3-${i}@example.com`, `Guest ${i}`)));
    for (const g of guests) {
      expect((await env.PARTY.getByName('ZXCVB').join(g.member, g.name, null)).ok).toBe(true);
    }

    const notHost = await env.PARTY.getByName('ZXCVB').close(guests[0].id);
    expect(notHost).toMatchObject({ ok: false, error: { message: 'You must be the host to close the party.' } });

    const closed = await env.PARTY.getByName('ZXCVB').close(host.id);
    expect(closed).toMatchObject({ ok: true, view: { isClosed: true } });

    const everyone = [host, ...guests];
    const targets = await Promise.all(everyone.map(u => env.PARTY.getByName('ZXCVB').view(u.id)));
    const targetIds = targets.map((v: any) => v!.target!.id);
    everyone.forEach((u, i) => expect(targetIds[i]).not.toBe(u.id));
    expect(new Set(targetIds).size).toBe(everyone.length);

    const late = await signIn('late3@example.com', 'Late');
    expect(await env.PARTY.getByName('ZXCVB').join(late.member, 'Late', null)).toMatchObject({ ok: false, error: { fieldName: 'party' } });
    expect(await env.PARTY.getByName('ZXCVB').leave(guests[0].id)).toMatchObject({ ok: false, error: { fieldName: 'party' } });
    expect(await env.PARTY.getByName('ZXCVB').close(host.id)).toMatchObject({ ok: false, error: { message: 'Party is already closed.' } });

    // Five notification emails plus the party-list updates go out through the local email binding.
    await drainOutbox('ZXCVB');
  });

  it('needs at least two participants to close', async () => {
    const host = await signIn('host4@example.com', 'Host');
    await createParty('POIUY', host.member);
    expect(await env.PARTY.getByName('POIUY').close(host.id)).toMatchObject({ ok: false, error: { fieldName: 'party' } });
  });

  it('delivers the outbox to the users: party lists, and names only for empty profiles', async () => {
    const host = await signIn('host5@example.com', 'Host');
    const guest = await signIn('guest5@example.com', 'Old name');
    const stub = env.PARTY.getByName('LKJHG');
    await createParty('LKJHG', host.member);
    await stub.join(guest.member, 'New name', null);

    // Delivered before join() returned, no alarm needed.
    expect(await stub.pendingOutbox()).toBe(0);
    expect((await env.USER.getByName('host5@example.com').listParties(10)).map((p: { slug: string }) => p.slug)).toEqual(['LKJHG']);
    expect((await env.USER.getByName('guest5@example.com').listParties(10)).map((p: { slug: string }) => p.slug)).toEqual(['LKJHG']);
    expect((await env.USER.getByName('guest5@example.com').get())!.name).toBe('Old name');

    await stub.leave(guest.id);
    expect(await env.USER.getByName('guest5@example.com').listParties(10)).toEqual([]);
  });

  it('keeps a user\'s messages in order while an earlier one waits for a retry', async () => {
    const host = await signIn('host6@example.com', 'Host');
    const guest = await signIn('guest6@example.com', 'Guest');
    const stub = env.PARTY.getByName('HGFDS');
    await createParty('HGFDS', host.member);
    await stub.join(guest.member, 'Guest', null);

    // Simulate an earlier message for the guest that failed and is waiting for its retry. It is the older user.setName
    // form, queued before joining stopped overwriting names: it is delivered as setNameIfEmpty.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO outbox (payload, attempts, next_attempt_at) VALUES (?, 1, ?)',
        JSON.stringify({ kind: 'user.setName', email: 'guest6@example.com', name: 'Retried' }), Date.now() + 60_000,
      );
    });

    await stub.leave(guest.id);
    expect(await stub.pendingOutbox()).toBe(2);
    expect((await env.USER.getByName('guest6@example.com').listParties(10)).map((p: { slug: string }) => p.slug)).toEqual(['HGFDS']);

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec('UPDATE outbox SET next_attempt_at = 0');
    });
    await drainOutbox('HGFDS');
    expect((await env.USER.getByName('guest6@example.com').get())!.name).toBe('Guest');
    expect(await env.USER.getByName('guest6@example.com').listParties(10)).toEqual([]);
  });

});
