import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { PartyDO } from 'src/do/PartyDO';
import { newObjectId } from 'src/utils/ids';

let counter = 0;
const code = () => {
  const abc = 'QWERTYUIPASDFGHJKLZXCVBNMO';
  let n = ++counter + 1000;
  let s = '';
  for (let i = 0; i < 5; i++) {
    s += abc[n % abc.length];
    n = Math.floor(n / abc.length);
  }
  return s;
};

const member = (label: string, email: string | null = `${label}-${++counter}@example.com`) =>
  ({ id: newObjectId(), email, name: label });

async function party(host = member('host'), password: string | null = null) {
  const slug = code();
  const stub = env.PARTY.getByName(slug);
  const created = await stub.create({ id: newObjectId(), slug, name: `Party ${slug}`, password, host });
  if (!created.ok) throw new Error('create failed');
  return { slug, stub, host };
}

const insertOutbox = (stub: DurableObjectStub<PartyDO>, message: object, attempts = 0, nextAttemptAt = 0) =>
  runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      'INSERT INTO outbox (payload, attempts, next_attempt_at) VALUES (?, ?, ?)',
      JSON.stringify(message), attempts, nextAttemptAt,
    );
  });

const mockEmail = (stub: DurableObjectStub<PartyDO>, send: (message: unknown) => Promise<unknown>) =>
  runInDurableObject(stub, async (instance: PartyDO) => {
    const self = instance as unknown as { env: object };
    self.env = { ...self.env, EMAIL: { send } };
  });

describe('PartyDO edge cases', () => {
  it('refuses join, leave and close on a party that does not exist', async () => {
    const stub = env.PARTY.getByName(code());
    const someone = member('someone');
    const missing = { ok: false, error: { fieldName: 'party', message: 'Party does not exist.' } };
    expect(await stub.join(someone, 'Someone', null)).toEqual(missing);
    expect(await stub.leave(someone.id)).toEqual(missing);
    expect(await stub.close(someone.id)).toEqual(missing);
    expect(await stub.pendingOutbox()).toBe(0);
    await runDurableObjectAlarm(stub);
  });

  it('shows anonymous visitors a view without membership details', async () => {
    const { stub } = await party(member('host'), 'pw');
    expect(await stub.view()).toMatchObject({ isJoined: false, isHost: false, participantCount: null, participants: null, password: null, isProtected: true });
  });

  it('returns the current view when a member joins again', async () => {
    const { stub, host } = await party();
    expect(await stub.join(host, 'Again', null)).toMatchObject({ ok: true, view: { isJoined: true, participantCount: 1 } });
  });

  it('falls back to the person\'s name, and needs some name', async () => {
    const { stub } = await party();
    const named = member('Named');
    expect(await stub.join(named, '', null)).toMatchObject({ ok: true, view: { participants: expect.any(Array) } });
    const nameless = { ...member('x'), name: '' };
    expect(await stub.join(nameless, '', null)).toEqual({ ok: false, error: { fieldName: 'name', message: 'We were unable to get your name.' } });
  });

  it('handles members without an email (legacy users): no user updates, no mail', async () => {
    const legacyHost = member('legacy-host', null);
    const { stub, slug } = await party(legacyHost);
    const legacy = member('legacy', null);
    expect((await stub.join(legacy, 'Legacy', null)).ok).toBe(true);
    expect(await stub.pendingOutbox()).toBe(0);
    expect((await stub.leave(legacy.id)).ok).toBe(true);
    expect(await stub.pendingOutbox()).toBe(0);

    await stub.join(legacy, 'Legacy', null);
    expect((await stub.close(legacyHost.id)).ok).toBe(true);
    expect(await stub.pendingOutbox()).toBe(0);
    expect(slug).toHaveLength(5);
  });

  it('treats leaving a party you are not in as a no-op', async () => {
    const { stub } = await party();
    expect(await stub.leave(newObjectId())).toMatchObject({ ok: true, view: { isJoined: false } });
  });


  it('reports no pending outbox and does nothing on alarm for an unknown party', async () => {
    const stub = env.PARTY.getByName(code());
    expect(await stub.pendingOutbox()).toBe(0);
    await runInDurableObject(stub, async (instance: PartyDO) => {
      await instance.alarm();
    });
    expect(await stub.view()).toBeNull();
  });
});

describe('PartyDO outbox', () => {
  it('leaves mail for the alarm when delivering user updates inline', async () => {
    const { stub, slug } = await party();
    const sent: unknown[] = [];
    await mockEmail(stub, async message => { sent.push(message); return { messageId: 'm' }; });
    await insertOutbox(stub, { kind: 'mail.partyNotification', email: 'a@example.com', partyName: 'P', slug });

    await stub.join(member('guest'), 'Guest', null);
    expect(sent).toHaveLength(0);
    expect(await stub.pendingOutbox()).toBe(1);

    await runInDurableObject(stub, async (instance: PartyDO) => instance.alarm());
    expect(sent).toHaveLength(1);
    expect(await stub.pendingOutbox()).toBe(0);
  });

  it('drops a message on a permanent mail error', async () => {
    const { stub, slug } = await party();
    await mockEmail(stub, async () => {
      throw Object.assign(new Error('suppressed'), { code: 'E_RECIPIENT_SUPPRESSED' });
    });
    await insertOutbox(stub, { kind: 'mail.partyNotification', email: 'gone@example.com', partyName: 'P', slug });
    await runInDurableObject(stub, async (instance: PartyDO) => instance.alarm());
    expect(await stub.pendingOutbox()).toBe(0);
  });

  it('retries a transient mail error with backoff, then gives up after the last attempt', async () => {
    const { stub, slug } = await party();
    await mockEmail(stub, async () => {
      throw Object.assign(new Error('try later'), { code: 'E_RATE_LIMIT_EXCEEDED' });
    });
    await insertOutbox(stub, { kind: 'mail.partyNotification', email: 'busy@example.com', partyName: 'P', slug });
    await runInDurableObject(stub, async (instance: PartyDO, state) => {
      await instance.alarm();
      const [row] = state.storage.sql.exec<{ attempts: number; next_attempt_at: number }>('SELECT attempts, next_attempt_at FROM outbox').toArray();
      expect(row.attempts).toBe(1);
      expect(row.next_attempt_at).toBeGreaterThan(Date.now());
      expect(await state.storage.getAlarm()).toBe(row.next_attempt_at);

      state.storage.sql.exec('UPDATE outbox SET attempts = 14, next_attempt_at = 0');
      await instance.alarm();
    });
    expect(await stub.pendingOutbox()).toBe(0);
  });

  it('keeps working after a failed run', async () => {
    const { stub, slug } = await party();
    await mockEmail(stub, async () => ({ messageId: 'm' }));
    await insertOutbox(stub, { kind: 'mail.partyNotification', email: 'a@example.com', partyName: 'P', slug });
    await runInDurableObject(stub, async (instance: PartyDO) => {
      const runOutbox = (instance as unknown as { runOutbox: (filter: () => boolean) => Promise<void> }).runOutbox.bind(instance);
      await expect(runOutbox(() => { throw new Error('boom'); })).rejects.toThrow('boom');
      await expect(runOutbox(() => true)).resolves.toBeInstanceOf(Map);
    });
  });
});

describe('UserDO', () => {
  it('returns the same user on every sign-in', async () => {
    const email = `same-${++counter}@example.com`;
    const first = await env.USER.getByName(email).ensure(email);
    const second = await env.USER.getByName(email).ensure(email);
    expect(second).toEqual(first);
  });

  it('redeems each magic link once, and forgets links once they have expired', async () => {
    const email = `redeem-${++counter}@example.com`;
    const stub = env.USER.getByName(email);
    const inFiveMinutes = Date.now() + 5 * 60 * 1000;

    const user = await stub.redeemMagicLink(email, 'link-1', inFiveMinutes);
    expect(user).toMatchObject({ email });
    expect(await stub.redeemMagicLink(email, 'link-1', inFiveMinutes)).toBeNull();
    expect(await stub.redeemMagicLink(email, 'link-2', inFiveMinutes)).toEqual(user);

    await stub.redeemMagicLink(email, 'old-link', Date.now() - 1000);
    await stub.redeemMagicLink(email, 'link-3', inFiveMinutes);
    await runInDurableObject(stub, async (_instance, state) => {
      const jtis = state.storage.sql.exec<{ jti: string }>('SELECT jti FROM used_magic_links ORDER BY jti').toArray().map(r => r.jti);
      expect(jtis).toEqual(['link-1', 'link-2', 'link-3']);
    });
  });

  it('starts every user at token version 0', async () => {
    const email = `version-${++counter}@example.com`;
    expect(await env.USER.getByName(email).ensure(email)).toMatchObject({ tokenVersion: 0 });
    expect(await env.USER.getByName(email).get()).toMatchObject({ tokenVersion: 0 });
  });

  it('fills in an empty profile name from a join, but never overwrites one', async () => {
    const email = `name-${++counter}@example.com`;
    const stub = env.USER.getByName(email);
    await stub.ensure(email);
    expect(await stub.apply([{ type: 'setNameIfEmpty', name: 'First' }])).toMatchObject({ name: 'First' });
    expect(await stub.apply([{ type: 'setNameIfEmpty', name: 'Second' }])).toMatchObject({ name: 'First' });
    expect(await stub.apply([{ type: 'setName', name: 'Edited' }])).toMatchObject({ name: 'Edited' });
  });

  it('fills in the name only on the account that joined', async () => {
    const email = `account-${++counter}@example.com`;
    const stub = env.USER.getByName(email);
    const user = await stub.ensure(email);
    expect(await stub.apply([{ type: 'setNameIfEmpty', name: 'Someone else', userId: newObjectId() }])).toMatchObject({ name: '' });
    expect(await stub.apply([{ type: 'setNameIfEmpty', name: 'Me', userId: user.id }])).toMatchObject({ name: 'Me' });
  });

  it('updates the profile name only for a session that still belongs to the user', async () => {
    const email = `update-${++counter}@example.com`;
    const stub = env.USER.getByName(email);
    const user = await stub.ensure(email);
    expect(await stub.updateName('New', { userId: user.id })).toMatchObject({ id: user.id, name: 'New', tokenVersion: 0 });
    expect(await stub.updateName('New', { userId: user.id, tokenVersion: 0 })).toMatchObject({ name: 'New' });
    expect(await stub.updateName('Other', { userId: user.id, tokenVersion: 1 })).toBeNull();
    expect(await stub.updateName('Other', { userId: newObjectId() })).toBeNull();
    expect((await stub.get())!.name).toBe('New');
    expect(await env.USER.getByName(`nobody-${++counter}@example.com`).updateName('X', { userId: user.id })).toBeNull();
  });

  it('leaves a tombstone on deletion: nothing to read, nothing written, tokens revoked', async () => {
    const email = `tomb-${++counter}@example.com`;
    const stub = env.USER.getByName(email);
    const user = await stub.ensure(email);
    await stub.apply([
      { type: 'setName', name: 'Gone' },
      { type: 'addParty', party: { slug: 'QQQQA', name: 'P', createdAt: 1, isHost: true, isProtected: false, isClosed: false } },
    ]);

    await stub.tombstone();
    expect(await stub.get()).toBeNull();
    expect(await stub.listParties(10)).toEqual([]);
    expect(await stub.updateName('Back', { userId: user.id })).toBeNull();

    // A late outbox delivery can't bring the record back.
    expect(await stub.apply([
      { type: 'setName', name: 'Resurrected' },
      { type: 'addParty', party: { slug: 'QQQQB', name: 'Late', createdAt: 2, isHost: false, isProtected: false, isClosed: false } },
    ])).toBeNull();
    expect(await stub.listParties(10)).toEqual([]);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec('SELECT name, token_version FROM user').one()).toEqual({ name: '', token_version: 1 });
    });

    // Signing in again starts a new account; tokens of the old one stay revoked.
    const fresh = await stub.ensure(email);
    expect(fresh).toMatchObject({ email, name: '', tokenVersion: 1 });
    expect(fresh.id).not.toBe(user.id);
    expect(await stub.get()).toEqual(fresh);
    expect(await stub.ensure(email)).toEqual(fresh);
  });

  it('applies party updates even before the user signs in, and reports no user', async () => {
    const email = `early-${++counter}@example.com`;
    const stub = env.USER.getByName(email);
    expect(await stub.apply([{ type: 'addParty', party: { slug: 'QQQQC', name: 'P', createdAt: 1, isHost: false, isProtected: false, isClosed: false } }])).toBeNull();
    expect(await stub.listParties(10)).toHaveLength(1);
  });

  it('pages through parties created at the same moment without skipping or repeating any', async () => {
    const email = `paging-${++counter}@example.com`;
    const stub = env.USER.getByName(email);
    const party = (slug: string, createdAt: number) =>
      ({ type: 'addParty' as const, party: { slug, name: slug, createdAt, isHost: false, isProtected: false, isClosed: false } });
    await stub.apply([party('QQQAA', 5), party('QQQAB', 7), party('QQQAC', 7), party('QQQAD', 7), party('QQQAE', 3)]);

    const seen: string[] = [];
    let after: { createdAt: number; slug: string } | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await stub.listParties(2, after);
      if (!page.length) break;
      seen.push(...page.map(p => p.slug));
      const last = page.at(-1)!;
      after = { createdAt: last.createdAt, slug: last.slug };
    }
    expect(seen).toEqual(['QQQAD', 'QQQAC', 'QQQAB', 'QQQAA', 'QQQAE']);
  });

  it('adds the token version and tombstone columns to an existing user table', async () => {
    const email = `migrate-user-${++counter}@example.com`;
    const stub = env.USER.getByName(email);
    await stub.ensure(email);
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec('DROP TABLE user');
      state.storage.sql.exec("CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', joined INTEGER NOT NULL)");
      state.storage.sql.exec("INSERT INTO user VALUES ('abc', ?, 'Old', 1)", email);
    });
    await evictDurableObject(stub);
    expect(await env.USER.getByName(email).get()).toEqual({ id: 'abc', email, name: 'Old', joined: 1, tokenVersion: 0 });
  });
});

describe('PartyDO join session check', () => {
  const signedUp = async (label: string) => {
    const email = `${label}-${++counter}@example.com`;
    const user = await env.USER.getByName(email).ensure(email);
    return { id: user.id, email, name: label };
  };

  it('lets a valid session join, with or without a token version', async () => {
    const { stub } = await party();
    const guest = await signedUp('guest');
    expect(await stub.join(guest, 'Guest', null, { tokenVersion: 0 })).toMatchObject({ ok: true, view: { isJoined: true } });
    const legacy = await signedUp('legacy');
    expect(await stub.join(legacy, 'Legacy', null, {})).toMatchObject({ ok: true, view: { isJoined: true, participantCount: 3 } });
  });

  it('undoes the membership when the account was deleted', async () => {
    const { stub, host } = await party();
    const guest = await signedUp('deleted');
    await env.USER.getByName(guest.email).tombstone();
    expect(await stub.join(guest, 'Ghost', null, {})).toEqual({
      ok: false, error: { fieldName: null, message: 'You must be logged in before joining the party.' },
    });
    expect(await stub.view(host.id)).toMatchObject({ participantCount: 1 });
    expect(await stub.pendingOutbox()).toBe(0);
    expect(await env.USER.getByName(guest.email).listParties(10)).toEqual([]);
  });

  it('undoes the membership for a revoked token, and takes the party back off the user\'s list', async () => {
    const { stub, host } = await party();
    const guest = await signedUp('revoked');
    // The account was deleted and the email signed up again: the old token has the old id and version.
    await env.USER.getByName(guest.email).tombstone();
    const fresh = await env.USER.getByName(guest.email).ensure(guest.email);

    expect(await stub.join(guest, 'Old', null, { tokenVersion: 0 })).toMatchObject({ ok: false, error: { fieldName: null } });
    // The old account's join didn't name the new account.
    expect((await env.USER.getByName(guest.email).get())!.name).toBe('');
    expect(await stub.join({ ...guest, id: fresh.id }, 'Stale', null, { tokenVersion: 0 })).toMatchObject({ ok: false });
    expect(await stub.view(host.id)).toMatchObject({ participantCount: 1 });
    expect(await env.USER.getByName(guest.email).listParties(10)).toEqual([]);

    expect(await stub.join({ ...guest, id: fresh.id }, 'Fresh', null, { tokenVersion: 1 })).toMatchObject({ ok: true });
    expect(await env.USER.getByName(guest.email).listParties(10)).toHaveLength(1);
  });

  it('lets the join stand when the user update has to wait for a retry', async () => {
    const { stub } = await party();
    const guest = await signedUp('waiting');
    await env.USER.getByName(guest.email).tombstone();
    await insertOutbox(stub, { kind: 'user.sync', email: guest.email }, 1, Date.now() + 60_000);
    expect(await stub.join(guest, 'Waiting', null, {})).toMatchObject({ ok: true, view: { isJoined: true } });
  });

  it('skips the check for members without an email (legacy users)', async () => {
    const { stub } = await party();
    expect(await stub.join(member('nomail', null), 'No mail', null, {})).toMatchObject({ ok: true });
  });

  it('delivers an older queued user.setName as setNameIfEmpty', async () => {
    const { stub } = await party();
    const named = await signedUp('named');
    const unnamed = await signedUp('unnamed');
    await env.USER.getByName(named.email).apply([{ type: 'setName', name: 'Kept' }]);
    await insertOutbox(stub, { kind: 'user.setName', email: named.email, name: 'Overwrite' });
    await insertOutbox(stub, { kind: 'user.setName', email: unnamed.email, name: 'Filled' });
    await runInDurableObject(stub, async (instance: PartyDO) => instance.alarm());
    expect((await env.USER.getByName(named.email).get())!.name).toBe('Kept');
    expect((await env.USER.getByName(unnamed.email).get())!.name).toBe('Filled');
  });
});
