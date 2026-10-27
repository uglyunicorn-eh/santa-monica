import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { AUTO_PRUNE_SINCE, PRUNE_AFTER_MS, PRUNED_RESTORE_WINDOW_MS, RESTORE_WINDOW_MS } from 'src/do/PartyDO';
import { renderPartyPruned } from 'src/mail';

import { mailer, request, signIn, uniqueEmail } from './helpers';

// Plan section 5: an open party with no activity for 45 days is deleted, restorable for a week, then erased.

const DAY = 24 * 60 * 60 * 1000;

/** A prune date far off, so no alarm acts on it while a test checks whether a write moves it. */
const FAR_OFF = Date.now() + 365 * DAY;

const createParty = async (token: string, name = 'Quiet party') =>
  (await request('POST', '/v1/parties', { token, body: { name } })).body as { code: string };
const write = (path: string, token: string, body: object) => request('POST', `/v1/parties/${path}`, { token, body });

const partySql = <T = Record<string, unknown>>(code: string, query: string, ...params: unknown[]) =>
  runInDurableObject(env.PARTY.getByName(code), async (_i, state) => state.storage.sql.exec(query, ...params).toArray() as T[]);
const pruneAt = async (code: string) => (await partySql<{ prune_at: number }>(code, 'SELECT prune_at FROM party'))[0].prune_at;

/** Captures the party's emails, and runs its alarm now (as if its time had come). */
async function runAlarm(code: string) {
  const { sent, EMAIL } = mailer();
  await runInDurableObject(env.PARTY.getByName(code), async instance => {
    const self = instance as unknown as { env: object };
    self.env = { ...self.env, EMAIL };
  });
  await runInDurableObject(env.PARTY.getByName(code), async (_i, state) => state.storage.setAlarm(Date.now()));
  await runDurableObjectAlarm(env.PARTY.getByName(code));
  // Deliveries the alarm queued for later (list updates, the email) go out too.
  for (let i = 0; i < 5 && await env.PARTY.getByName(code).pendingOutbox(); i++) {
    await runInDurableObject(env.PARTY.getByName(code), async (_i, state) => state.storage.setAlarm(Date.now()));
    await runDurableObjectAlarm(env.PARTY.getByName(code));
  }
  return sent;
}

const myParties = async (token: string) => (await request('GET', '/v1/me/parties', { token })).body.items as { code: string; deletedAt: string | null; restorableUntil: string | null }[];

describe('auto-prune', () => {
  it('starts every party with 45 days, and every write by a person gives it 45 more; a lookup does not', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const guest = await signIn(uniqueEmail('guest'), 'Guest');
    const before = Date.now();
    const { code } = await createParty(host.token);
    expect(await pruneAt(code)).toBeGreaterThanOrEqual(before + PRUNE_AFTER_MS);
    const writes: [string, string, object][] = [
      ['join', guest.token, { code, name: 'Guest' }],
      ['leave', guest.token, { code }],
      ['invite', host.token, { code, emails: [uniqueEmail('invited')] }],
    ];
    for (const [path, token, body] of writes) {
      await partySql(code, 'UPDATE party SET prune_at = ?', FAR_OFF);
      expect((await write(path, token, body)).status).toBe(200);
      expect([path, await pruneAt(code) > Date.now() + PRUNE_AFTER_MS - 60_000 && await pruneAt(code) < FAR_OFF]).toEqual([path, true]);
    }
    await partySql(code, 'UPDATE party SET prune_at = ?', FAR_OFF);
    await request('POST', '/v1/parties/lookup', { body: { code } });
    await request('POST', '/v1/parties/lookup', { token: host.token, body: { code } });
    expect(await pruneAt(code)).toBe(FAR_OFF);
  });

  it('deletes a quiet open party, mails its host once, drops it from the guests\' lists, and keeps it a week', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const guest = await signIn(uniqueEmail('guest'), 'Guest');
    const { code } = await createParty(host.token, 'Forgotten');
    await write('join', guest.token, { code, name: 'Guest' });
    await partySql(code, 'UPDATE party SET prune_at = ?', Date.now() - 1000);
    const sent = await runAlarm(code);
    expect(sent.map(m => [m.to, m.subject])).toEqual([[host.email, 'Forgotten was put away']]);
    expect(sent[0].text).toContain(`/p/${code}/`);

    const [{ deleted_at: deletedAt, restorable_until: until }] = await partySql<{ deleted_at: number; restorable_until: number }>(code, 'SELECT deleted_at, restorable_until FROM party');
    expect(until - deletedAt).toBe(PRUNED_RESTORE_WINDOW_MS);
    expect((await request('POST', '/v1/parties/lookup', { body: { code } })).status).toBe(404);
    expect((await request('POST', '/v1/parties/lookup', { token: host.token, body: { code } })).body)
      .toMatchObject({ isHost: true, restorableUntil: new Date(until).toISOString() });
    expect((await myParties(host.token)).find(p => p.code === code)).toMatchObject({ restorableUntil: new Date(until).toISOString() });
    expect((await myParties(guest.token)).map(p => p.code)).not.toContain(code);
    // A second alarm sends nothing more.
    expect(await runAlarm(code)).toEqual([]);
  });

  it('can be restored within the week, with 45 fresh days, and is erased for good after it', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const { code } = await createParty(host.token, 'Back again');
    await partySql(code, 'UPDATE party SET prune_at = ?', Date.now() - 1000);
    await runAlarm(code);
    // Six days later, still restorable.
    await partySql(code, 'UPDATE party SET deleted_at = deleted_at - ?, restorable_until = restorable_until - ?', 6 * DAY, 6 * DAY);
    expect((await write('restore', host.token, { code })).status).toBe(200);
    expect(await pruneAt(code)).toBeGreaterThan(Date.now() + PRUNE_AFTER_MS - 60_000);

    await partySql(code, 'UPDATE party SET prune_at = ?', Date.now() - 1000);
    await runAlarm(code);
    await partySql(code, 'UPDATE party SET deleted_at = deleted_at - ?, restorable_until = restorable_until - ?', 8 * DAY, 8 * DAY);
    await runAlarm(code);
    expect(await partySql(code, 'SELECT * FROM party')).toEqual([]);
    expect(await partySql(code, 'SELECT * FROM memberships')).toEqual([]);
    expect((await myParties(host.token)).map(p => p.code)).not.toContain(code);
  });

  it('deletes a quiet party whose host has no email on file (older data) without trying to mail them', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const { code } = await createParty(host.token, 'No address');
    await partySql(code, 'UPDATE memberships SET member_email = NULL');
    await partySql(code, 'UPDATE party SET prune_at = ?', Date.now() - 1000);
    expect(await runAlarm(code)).toEqual([]);
    expect((await partySql<{ deleted_at: number | null }>(code, 'SELECT deleted_at FROM party'))[0].deleted_at).not.toBeNull();
  });

  it("leaves a host's own delete its 24 hours, and never prunes a drawn party", async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const guest = await signIn(uniqueEmail('guest'), 'Guest');
    const deleted = await createParty(host.token, 'Mine to delete');
    await write('delete', host.token, { code: deleted.code });
    const [row] = await partySql<{ deleted_at: number; restorable_until: number }>(deleted.code, 'SELECT deleted_at, restorable_until FROM party');
    expect(row.restorable_until - row.deleted_at).toBe(RESTORE_WINDOW_MS);

    const drawn = await createParty(host.token, 'Drawn');
    await write('join', guest.token, { code: drawn.code, name: 'Guest' });
    await write('draw', host.token, { code: drawn.code });
    await partySql(drawn.code, 'UPDATE party SET prune_at = ?', Date.now() - 1000);
    expect(await runAlarm(drawn.code)).toEqual([]);
    expect(await partySql(drawn.code, 'SELECT deleted_at FROM party')).toEqual([{ deleted_at: null }]);
  });

  it('erases a party that went quiet before auto-prune at its first alarm, with no email', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const { code } = await createParty(host.token, 'Ancient');
    await partySql(code, 'UPDATE party SET prune_at = ?', AUTO_PRUNE_SINCE - 1);
    expect(await runAlarm(code)).toEqual([]);
    expect(await partySql(code, 'SELECT * FROM party')).toEqual([]);
    expect(await partySql(code, 'SELECT slug FROM cancelled')).toEqual([{ slug: code }]);
    expect((await myParties(host.token)).map(p => p.code)).not.toContain(code);
  });

  it('gives a party made before auto-prune its date from its last activity, and its alarm, when it starts', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const guest = await signIn(uniqueEmail('guest'), 'Guest');
    const { code } = await createParty(host.token, 'Older');
    await write('join', guest.token, { code, name: 'Guest' });
    const joinedAt = Date.now() - 10 * DAY;
    await runInDurableObject(env.PARTY.getByName(code), async (_i, state) => {
      state.storage.sql.exec('ALTER TABLE party DROP COLUMN prune_at');
      state.storage.sql.exec('UPDATE party SET created_at = ?', joinedAt - 5 * DAY);
      state.storage.sql.exec('UPDATE memberships SET joined_at = ?', joinedAt);
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(env.PARTY.getByName(code));
    expect((await request('POST', '/v1/parties/lookup', { body: { code } })).status).toBe(200);
    expect(await pruneAt(code)).toBe(joinedAt + PRUNE_AFTER_MS);
    const alarm = await runInDurableObject(env.PARTY.getByName(code), async (_i, state) => state.storage.getAlarm());
    expect(alarm).toBe(joinedAt + PRUNE_AFTER_MS);
  });

  it("writes the host an email that says until when the party can come back", () => {
    const message = renderPartyPruned({ party: { name: 'Office <party>', url: 'https://gnomik.me/p/QWERTYUI/' }, restorableUntil: Date.UTC(2026, 11, 5, 12), assetsUrl: 'https://api.test' });
    expect(message.subject).toBe('Office <party> was put away');
    expect(message.text).toContain('until December 5, 2026');
    expect(message.text).toContain('https://gnomik.me/p/QWERTYUI/');
    expect(message.html).toContain('Office &lt;party&gt;');
  });
});
