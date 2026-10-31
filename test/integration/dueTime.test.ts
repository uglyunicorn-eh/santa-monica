import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { reminderAt } from 'src/do/PartyDO';

import { call, drawParty, joinParty, mailbox, settleParty, signIn, uniqueEmail, viewParty } from './support';

// A party's due time: set at creation (optional), shown to everyone who can see the party, and a reminder email to
// the host the day before, at the time of day the party was created. Nothing happens when the due time passes.

const DAY = 24 * 60 * 60 * 1000;

const partySql = <T = Record<string, unknown>>(code: string, query: string, ...params: unknown[]) =>
  runInDurableObject(env.PARTY.getByName(code), async (_i, state) => state.storage.sql.exec(query, ...params).toArray() as T[]);

/** Runs the party's alarm now, as if its time had come, and delivers what it queued. */
async function alarmNow(code: string) {
  await runInDurableObject(env.PARTY.getByName(code), async (_i, state) => state.storage.setAlarm(Date.now()));
  await runDurableObjectAlarm(env.PARTY.getByName(code));
  await settleParty(code);
}

const reminders = async (email: string) => (await mailbox(email)).filter(m => m.subject.endsWith('starts in about a day'));

describe("a party's due time", () => {
  it('is set at creation, shown to anyone who can see the party, and stays put once it has passed', async () => {
    const host = await signIn(uniqueEmail('host'));
    const due = new Date(Date.now() + 5 * DAY);
    due.setUTCMilliseconds(0);
    const created = await call('POST', '/v1/parties', { token: host.token, body: { name: 'Due', dueAt: due.toISOString() } });
    expect(created).toMatchObject({ status: 201, body: { dueAt: due.toISOString() } });
    expect((await viewParty(created.body.code)).body.dueAt).toBe(due.toISOString());
    expect((await viewParty(created.body.code, host)).body.dueAt).toBe(due.toISOString());
    // Past its due time, the party is just as it was: open, joinable, drawable.
    await partySql(created.body.code, 'UPDATE party SET due_at = ?', Date.now() - DAY);
    const guest = await signIn(uniqueEmail('guest'));
    expect((await joinParty(guest, created.body, 'Guest')).status).toBe(200);
    expect((await drawParty(host, created.body)).body).toMatchObject({ isClosed: true, dueAt: expect.any(String) });
  });

  it('is optional, and refused when it is not ahead by an hour or more, within a year', async () => {
    const host = await signIn(uniqueEmail('host'));
    expect((await call('POST', '/v1/parties', { token: host.token, body: { name: 'No due' } })).body.dueAt).toBeNull();
    const refused = await call('POST', '/v1/parties', { token: host.token, body: { name: 'Past', dueAt: new Date(Date.now() - DAY).toISOString() } });
    expect(refused).toMatchObject({ status: 400, body: { error: { code: 'invalid', field: 'dueAt' } } });
  });

  it('reminds the host once, the day before at the time of day the party was made, unless it was drawn', async () => {
    const host = await signIn(uniqueEmail('host'));
    const guest = await signIn(uniqueEmail('guest'));
    const due = Date.now() + 3 * DAY;
    const party = (await call('POST', '/v1/parties', { token: host.token, body: { name: 'Remind me', dueAt: new Date(due).toISOString() } })).body;
    await joinParty(guest, party, 'Guest');
    const [row] = await partySql<{ created_at: number; remind_at: number }>(party.code, 'SELECT created_at, remind_at FROM party');
    expect(row.remind_at).toBe(reminderAt(row.created_at, due));
    await alarmNow(party.code);
    expect(await reminders(host.email)).toEqual([]);
    await partySql(party.code, 'UPDATE party SET remind_at = ?', Date.now() - 1000);
    await alarmNow(party.code);
    const sent = await reminders(host.email);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('2 people are in');
    expect(sent[0].text).toContain(`https://gnomik.me/p/${party.code}/sign-in#`);
    expect(sent[0].text).toContain("please don't forward this email");
    expect(await reminders(guest.email)).toEqual([]);
    await alarmNow(party.code);
    expect(await reminders(host.email)).toHaveLength(1);

    const drawnHost = await signIn(uniqueEmail('drawn-host'));
    const drawn = (await call('POST', '/v1/parties', { token: drawnHost.token, body: { name: 'Drawn', dueAt: new Date(due).toISOString() } })).body;
    await joinParty(guest, drawn, 'Guest');
    await drawParty(drawnHost, drawn);
    await partySql(drawn.code, 'UPDATE party SET remind_at = ?', Date.now() - 1000);
    await alarmNow(drawn.code);
    expect(await reminders(drawnHost.email)).toEqual([]);
  });
});
