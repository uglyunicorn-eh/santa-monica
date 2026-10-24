import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
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

  it('imports open parties and targets without a stored name', async () => {
    const slug = code();
    const stub = env.PARTY.getByName(slug);
    const [a, b] = [newObjectId(), newObjectId()];
    await stub.importParty({
      id: newObjectId(), slug, name: 'Open', password: null, hostId: a, isClosed: false, createdAt: 1,
      members: [{ id: a, email: null, name: 'A', targetId: b, targetName: null, joinedAt: 1 }],
    });
    expect(await stub.view(a)).toMatchObject({ isClosed: false, target: null });

    await stub.importParty({
      id: newObjectId(), slug, name: 'Closed', password: null, hostId: a, isClosed: true, createdAt: 1,
      members: [{ id: a, email: null, name: 'A', targetId: b, targetName: null, joinedAt: 1 }],
    });
    expect(await stub.view(a)).toMatchObject({ isClosed: true, target: { id: b, name: '' } });
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
      await expect(runOutbox(() => true)).resolves.toBeUndefined();
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

  it('imports a user, replacing what was there', async () => {
    const email = `imported-${++counter}@example.com`;
    const stub = env.USER.getByName(email);
    await stub.ensure(email);
    await stub.addParty({ slug: 'OLDER', name: 'Old', createdAt: 1 });
    const id = newObjectId();
    expect(await stub.importUser({ id, email, name: 'Imported', joined: 5, parties: [{ slug: 'NEWER', name: 'New', createdAt: 2 }] })).toEqual({ parties: 1 });
    expect(await stub.get()).toEqual({ id, email, name: 'Imported', joined: 5 });
    expect(await stub.listParties(10)).toEqual([{ slug: 'NEWER', name: 'New', createdAt: 2 }]);
  });
});
