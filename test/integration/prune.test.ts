import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { AUTO_PRUNE_SINCE, PRUNE_AFTER_MS, PRUNED_RESTORE_WINDOW_MS, RESTORE_WINDOW_MS } from 'src/do/PartyDO';

import { call, createParty, deleteParty, drawParty, joinParty, leaveParty, mailbox, myParties, restoreParty, settleParty, signIn, uniqueEmail, viewParty } from './support';

// Plan section 5: an open party with no activity for 45 days is deleted, restorable for a week, then erased. Time
// can't move in the run, so a party's dates are moved back instead, and its alarm is run now.

const DAY = 24 * 60 * 60 * 1000;

/** A prune date far off, so no alarm acts on it while a test checks whether a write moves it. */
const FAR_OFF = Date.now() + 365 * DAY;

const partySql = <T = Record<string, unknown>>(code: string, query: string, ...params: unknown[]) =>
  runInDurableObject(env.PARTY.getByName(code), async (_i, state) => state.storage.sql.exec(query, ...params).toArray() as T[]);
const pruneAt = async (code: string) => (await partySql<{ prune_at: number }>(code, 'SELECT prune_at FROM party'))[0].prune_at;

/** Runs the party's alarm now, as if its time had come, and delivers what it queued. */
async function alarmNow(code: string) {
  await runInDurableObject(env.PARTY.getByName(code), async (_i, state) => state.storage.setAlarm(Date.now()));
  await runDurableObjectAlarm(env.PARTY.getByName(code));
  await settleParty(code);
}

const prunedMail = async (email: string) => (await mailbox(email)).filter(m => m.subject.endsWith('was put away'));

describe('auto-prune', () => {
  it('counts 45 days from the last write by a person: create, join, leave, invite and restore move it; a lookup does not', async () => {
    const host = await signIn(uniqueEmail('host'));
    const guest = await signIn(uniqueEmail('guest'));
    const party = await createParty(host, 'Busy');
    expect(await pruneAt(party.code)).toBeGreaterThan(Date.now() + PRUNE_AFTER_MS - 60_000);
    const writes: [string, () => Promise<{ status: number }>][] = [
      ['join', () => joinParty(guest, party, 'Guest')],
      ['leave', () => leaveParty(guest, party)],
      ['invite', () => call('POST', '/v1/parties/invite', { token: host.token, body: { code: party.code, emails: [uniqueEmail('invited')] } })],
      ['delete', () => deleteParty(host, party)],
      ['restore', () => restoreParty(host, party)],
    ];
    for (const [name, run] of writes) {
      await partySql(party.code, 'UPDATE party SET prune_at = ?', FAR_OFF);
      expect((await run()).status).toBe(200);
      if (name !== 'delete') {
        expect([name, await pruneAt(party.code) > Date.now() + PRUNE_AFTER_MS - 60_000 && await pruneAt(party.code) < FAR_OFF]).toEqual([name, true]);
      }
    }
    await partySql(party.code, 'UPDATE party SET prune_at = ?', FAR_OFF);
    await viewParty(party.code);
    await viewParty(party.code, host);
    expect(await pruneAt(party.code)).toBe(FAR_OFF);
  });

  it('deletes a quiet open party, mails its host once, drops it from the guests\' lists, and keeps it for the host a week', async () => {
    const host = await signIn(uniqueEmail('host'));
    const guest = await signIn(uniqueEmail('guest'));
    const party = await createParty(host, 'Forgotten');
    await joinParty(guest, party, 'Guest');
    await partySql(party.code, 'UPDATE party SET prune_at = ?', Date.now() - 1000);
    await alarmNow(party.code);
    expect((await prunedMail(host.email)).map(m => m.subject)).toEqual(['Forgotten was put away']);
    expect(await prunedMail(guest.email)).toEqual([]);
    const [{ deleted_at: deletedAt, restorable_until: until }] = await partySql<{ deleted_at: number; restorable_until: number }>(party.code, 'SELECT deleted_at, restorable_until FROM party');
    expect(until - deletedAt).toBe(PRUNED_RESTORE_WINDOW_MS);
    expect((await viewParty(party.code)).status).toBe(404);
    expect((await viewParty(party.code, host)).body).toMatchObject({ isHost: true, restorableUntil: new Date(until).toISOString() });
    expect((await myParties(host)).body.items.find(p => p.code === party.code)).toMatchObject({ restorableUntil: new Date(until).toISOString() });
    expect((await myParties(guest)).body.items.map(p => p.code)).not.toContain(party.code);
    await alarmNow(party.code);
    expect(await prunedMail(host.email)).toHaveLength(1);
  });

  it('can be restored within the week, with 45 fresh days, and is then erased for good', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host, 'Back again');
    await partySql(party.code, 'UPDATE party SET prune_at = ?', Date.now() - 1000);
    await alarmNow(party.code);
    await partySql(party.code, 'UPDATE party SET deleted_at = deleted_at - ?, restorable_until = restorable_until - ?', 6 * DAY, 6 * DAY);
    expect((await restoreParty(host, party)).status).toBe(200);
    expect(await pruneAt(party.code)).toBeGreaterThan(Date.now() + PRUNE_AFTER_MS - 60_000);
    expect((await viewParty(party.code)).status).toBe(200);

    await partySql(party.code, 'UPDATE party SET prune_at = ?', Date.now() - 1000);
    await alarmNow(party.code);
    await partySql(party.code, 'UPDATE party SET deleted_at = deleted_at - ?, restorable_until = restorable_until - ?', 8 * DAY, 8 * DAY);
    await alarmNow(party.code);
    expect(await partySql(party.code, 'SELECT * FROM party')).toEqual([]);
    expect(await partySql(party.code, 'SELECT * FROM memberships')).toEqual([]);
    expect((await myParties(host)).body.items.map(p => p.code)).not.toContain(party.code);
    expect((await restoreParty(host, party)).status).toBe(404);
  });

  it("keeps a host's own delete at 24 hours, and never prunes a drawn party", async () => {
    const host = await signIn(uniqueEmail('host'));
    const guest = await signIn(uniqueEmail('guest'));
    const mine = await createParty(host, 'Deleted by hand');
    await deleteParty(host, mine);
    const [row] = await partySql<{ deleted_at: number; restorable_until: number }>(mine.code, 'SELECT deleted_at, restorable_until FROM party');
    expect(row.restorable_until - row.deleted_at).toBe(RESTORE_WINDOW_MS);

    const drawn = await createParty(host, 'Drawn');
    await joinParty(guest, drawn, 'Guest');
    await drawParty(host, drawn);
    await partySql(drawn.code, 'UPDATE party SET prune_at = ?', Date.now() - 1000);
    await alarmNow(drawn.code);
    expect(await partySql(drawn.code, 'SELECT deleted_at FROM party')).toEqual([{ deleted_at: null }]);
    expect(await prunedMail(host.email)).toEqual([]);
  });

  it('erases a party that went quiet before auto-prune at its first alarm, with no email, and takes it off the host\'s list', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host, 'Ancient');
    await partySql(party.code, 'UPDATE party SET prune_at = ?', AUTO_PRUNE_SINCE - 1);
    await alarmNow(party.code);
    expect(await partySql(party.code, 'SELECT * FROM party')).toEqual([]);
    expect(await prunedMail(host.email)).toEqual([]);
    expect((await myParties(host)).body.items.map(p => p.code)).not.toContain(party.code);
    // Its code is never handed out again.
    expect(await partySql(party.code, 'SELECT slug FROM cancelled')).toEqual([{ slug: party.code }]);
  });

  it('erases an old party that nobody opens once something starts it: what `scripts/data.ts wake` does', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host, 'Never opened');
    await runInDurableObject(env.PARTY.getByName(party.code), async (_i, state) => {
      state.storage.sql.exec('ALTER TABLE party DROP COLUMN prune_at');
      state.storage.sql.exec('UPDATE party SET created_at = ?', AUTO_PRUNE_SINCE - PRUNE_AFTER_MS - 400 * DAY);
      state.storage.sql.exec('UPDATE memberships SET joined_at = ?', AUTO_PRUNE_SINCE - PRUNE_AFTER_MS - 400 * DAY);
      await state.storage.deleteAlarm();
    });
    // As if it was stored by an older release and has been asleep since.
    await evictDurableObject(env.PARTY.getByName(party.code));
    // The signed-out lookup the script sends starts it; it gets its date, and an alarm that's already due.
    await call('POST', '/v1/parties/lookup', { body: { code: party.code } });
    // Its alarm is due at once, so it may already have run on its own; run it if it's still waiting.
    await runDurableObjectAlarm(env.PARTY.getByName(party.code));
    await vi.waitFor(async () => expect(await partySql(party.code, 'SELECT * FROM party')).toEqual([]));
    await settleParty(party.code);
    expect((await viewParty(party.code)).status).toBe(404);
    await vi.waitFor(async () => expect((await myParties(host)).body.items.map(p => p.code)).not.toContain(party.code));
  });
});
