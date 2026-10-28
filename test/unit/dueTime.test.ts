import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { DUE_AT_MAX_MS } from 'src/api/limits';
import { reminderAt } from 'src/do/PartyDO';
import { renderPartyDue } from 'src/mail';

import { mailer, request, signIn, uniqueEmail } from './helpers';

// A party's due time: optional, shown as a countdown by the app, with a reminder to the host the day before.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (iso: string) => Date.parse(iso);

const createParty = (token: string, dueAt?: unknown) =>
  request('POST', '/v1/parties', { token, body: { name: 'Due party', ...(dueAt === undefined ? {} : { dueAt }) } });

const partySql = <T = Record<string, unknown>>(code: string, query: string, ...params: unknown[]) =>
  runInDurableObject(env.PARTY.getByName(code), async (_i, state) => state.storage.sql.exec(query, ...params).toArray() as T[]);

/** Runs the party's alarm now with its email captured, and delivers what it queued. */
async function alarmNow(code: string) {
  const { sent, EMAIL } = mailer();
  await runInDurableObject(env.PARTY.getByName(code), async (instance, state) => {
    (instance as unknown as { env: object }).env = { ...(instance as unknown as { env: object }).env, EMAIL };
    await state.storage.setAlarm(Date.now());
  });
  await runDurableObjectAlarm(env.PARTY.getByName(code));
  for (let i = 0; i < 5 && await env.PARTY.getByName(code).pendingOutbox(); i++) {
    await runInDurableObject(env.PARTY.getByName(code), async (_i, state) => state.storage.setAlarm(Date.now()));
    await runDurableObjectAlarm(env.PARTY.getByName(code));
  }
  return sent.filter(m => m.subject.endsWith('is due in about a day'));
}

describe('the reminder time', () => {
  it('is the day before, at the time of day the party was created', () => {
    expect(reminderAt(at('2026-11-01T09:30:00Z'), at('2026-12-20T18:00:00Z'))).toBe(at('2026-12-19T09:30:00Z'));
    // Created late: still the day before, later in that day.
    expect(reminderAt(at('2026-11-01T21:00:00Z'), at('2026-12-20T18:00:00Z'))).toBe(at('2026-12-19T21:00:00Z'));
    // Due early in the morning: the creation time on the evening before is nearer, then the day before that.
    expect(reminderAt(at('2026-11-01T09:30:00Z'), at('2026-12-20T01:00:00Z'))).toBe(at('2026-12-19T09:30:00Z'));
    expect(reminderAt(at('2026-11-01T23:00:00Z'), at('2026-12-20T06:00:00Z'))).toBe(at('2026-12-18T23:00:00Z'));
  });

  it('always lands 12 to 36 hours before the due time', () => {
    for (let minutes = 0; minutes < 24 * 60; minutes += 37) {
      const created = at('2026-11-01T00:00:00Z') + minutes * 60 * 1000;
      for (const due of [at('2026-12-20T00:00:00Z'), at('2026-12-20T07:45:00Z'), at('2026-12-20T23:59:00Z')]) {
        const remind = reminderAt(created, due)!;
        expect(due - remind).toBeGreaterThanOrEqual(12 * HOUR);
        expect(due - remind).toBeLessThanOrEqual(36 * HOUR);
        expect((remind - created) % DAY).toBe(0);
      }
    }
  });

  it('is none when it would already have passed', () => {
    const now = at('2026-11-01T12:00:00Z');
    expect(reminderAt(now, now + 2 * HOUR)).toBeNull();
    expect(reminderAt(now, now + 13 * HOUR)).toBeNull();
    expect(reminderAt(now, now + 2 * DAY)).toBe(now + DAY);
  });
});

describe('a due time on a new party', () => {
  it('is optional, and comes back in the party as an ISO time', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const none = await createParty(host.token);
    expect(none).toMatchObject({ status: 201, body: { dueAt: null } });
    expect((await createParty(host.token, null)).body.dueAt).toBeNull();
    const due = new Date(Date.now() + 3 * DAY);
    due.setUTCMilliseconds(0);
    const created = await createParty(host.token, due.toISOString().replace('.000Z', '+00:00'));
    expect(created).toMatchObject({ status: 201, body: { dueAt: due.toISOString() } });
    // Everyone who can see the party sees it, signed out too.
    expect((await request('POST', '/v1/parties/lookup', { body: { code: created.body.code } })).body.dueAt).toBe(due.toISOString());
    const [row] = await partySql<{ due_at: number; remind_at: number; created_at: number }>(created.body.code, 'SELECT due_at, remind_at, created_at FROM party');
    expect(row.due_at).toBe(due.getTime());
    expect(row.remind_at).toBe(reminderAt(row.created_at, due.getTime()));
  });

  it('must be a date-time with its offset, at least an hour ahead and within a year', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    for (const dueAt of ['tomorrow', '2026-12-20', '2026-12-20T18:00', 12345, new Date(Date.now() - HOUR).toISOString(), new Date(Date.now() + 30 * 60 * 1000).toISOString(), new Date(Date.now() + DUE_AT_MAX_MS + DAY).toISOString()]) {
      expect([dueAt, (await createParty(host.token, dueAt)).body.error?.field]).toEqual([dueAt, 'dueAt']);
    }
    // A day that doesn't exist in its month is refused, not moved into the next month.
    const nextYear = new Date().getUTCFullYear() + 1;
    for (const day of [`${nextYear}-02-30T18:00:00Z`, `${nextYear}-04-31T10:00:00+02:00`]) {
      expect([day, (await createParty(host.token, day)).body.error?.field]).toEqual([day, 'dueAt']);
    }
    // A real day with an offset is fine.
    expect((await createParty(host.token, new Date(Date.now() + 30 * DAY).toISOString().replace('Z', '+00:00'))).status).toBe(201);
  });
});

describe('the reminder', () => {
  it('goes to the host once, at its time, saying how many are in', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const guest = await signIn(uniqueEmail('guest'), 'Guest');
    const { body: party } = await createParty(host.token, new Date(Date.now() + 3 * DAY).toISOString());
    await request('POST', '/v1/parties/join', { token: guest.token, body: { code: party.code, name: 'Guest' } });
    // The party waits for it.
    const [{ remind_at: remindAt }] = await partySql<{ remind_at: number }>(party.code, 'SELECT remind_at FROM party');
    expect(await runInDurableObject(env.PARTY.getByName(party.code), async (_i, state) => state.storage.getAlarm())).toBeLessThanOrEqual(remindAt);
    // Not before its time.
    expect(await alarmNow(party.code)).toEqual([]);
    await partySql(party.code, 'UPDATE party SET remind_at = ?', Date.now() - 1000);
    const sent = await alarmNow(party.code);
    expect(sent.map(m => m.to)).toEqual([host.email]);
    expect(sent[0].text).toContain('2 people are in');
    expect(sent[0].text).toContain(`/p/${party.code}/`);
    expect(await partySql(party.code, 'SELECT remind_at FROM party')).toEqual([{ remind_at: null }]);
    expect(await alarmNow(party.code)).toEqual([]);
  });

  it('is not sent for a party drawn or deleted, nor to a host with no email on file', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const guest = await signIn(uniqueEmail('guest'), 'Guest');
    const due = new Date(Date.now() + 3 * DAY).toISOString();
    const drawn = (await createParty(host.token, due)).body;
    await request('POST', '/v1/parties/join', { token: guest.token, body: { code: drawn.code, name: 'Guest' } });
    await request('POST', '/v1/parties/draw', { token: host.token, body: { code: drawn.code } });
    const deleted = (await createParty(host.token, due)).body;
    await request('POST', '/v1/parties/delete', { token: host.token, body: { code: deleted.code } });
    const noEmail = (await createParty(host.token, due)).body;
    await partySql(noEmail.code, 'UPDATE memberships SET member_email = NULL');
    for (const code of [drawn.code, deleted.code, noEmail.code]) {
      await partySql(code, 'UPDATE party SET remind_at = ?', Date.now() - 1000);
      expect([code, await alarmNow(code)]).toEqual([code, []]);
    }
    // A drawn or deleted party keeps it (a restore brings it back); a host with no email just doesn't get one.
    expect((await partySql<{ remind_at: number | null }>(drawn.code, 'SELECT remind_at FROM party'))[0].remind_at).not.toBeNull();
    expect((await partySql<{ remind_at: number | null }>(deleted.code, 'SELECT remind_at FROM party'))[0].remind_at).not.toBeNull();
    expect(await partySql(noEmail.code, 'SELECT remind_at FROM party')).toEqual([{ remind_at: null }]);
  });

  it('comes back with a restored party, unless its due time has passed by then', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const due = new Date(Date.now() + 3 * DAY).toISOString();
    const restored = (await createParty(host.token, due)).body;
    await request('POST', '/v1/parties/delete', { token: host.token, body: { code: restored.code } });
    await partySql(restored.code, 'UPDATE party SET remind_at = ?', Date.now() - 1000);
    expect(await alarmNow(restored.code)).toEqual([]);
    expect((await request('POST', '/v1/parties/restore', { token: host.token, body: { code: restored.code } })).status).toBe(200);
    expect((await alarmNow(restored.code)).map(m => m.to)).toEqual([host.email]);

    const late = (await createParty(host.token, due)).body;
    await request('POST', '/v1/parties/delete', { token: host.token, body: { code: late.code } });
    await request('POST', '/v1/parties/restore', { token: host.token, body: { code: late.code } });
    await partySql(late.code, 'UPDATE party SET remind_at = ?, due_at = ?', Date.now() - 2000, Date.now() - 1000);
    expect(await alarmNow(late.code)).toEqual([]);
    expect(await partySql(late.code, 'SELECT remind_at FROM party')).toEqual([{ remind_at: null }]);
  });

  it('reads well for a host on their own', () => {
    const message = renderPartyDue({ party: { name: 'Office <party>', url: 'https://gnomik.me/p/QWERTYUI/' }, members: 1, assetsUrl: 'https://api.test' });
    expect(message.subject).toBe('Office <party> is due in about a day');
    expect(message.text).toContain('only you are in so far');
    expect(message.html).toContain('Office &lt;party&gt;');
  });
});
