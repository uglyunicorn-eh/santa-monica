import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { MAX_PARTY_INVITES, PartyDO, REINVITE_AFTER_MS } from 'src/do/PartyDO';

import { drainOutbox, mailer, request, signIn, uniqueEmail } from './helpers';

const createParty = async (token: string) => (await request('POST', '/v1/parties', { token, body: { name: 'Party' } })).body as { code: string };
const join = (token: string, code: string, name = 'Guest') => request('POST', '/v1/parties/join', { token, body: { code, name } });
const invite = (token: string, code: string, emails: string[]) => request('POST', '/v1/parties/invite', { token, body: { code, emails } });

/** The party's own EMAIL binding, so its outbox delivers to a recorder instead of the real one. */
const quietMail = (code: string) => runInDurableObject(env.PARTY.getByName(code), async instance => {
  const self = instance as unknown as { env: object };
  self.env = { ...self.env, EMAIL: mailer().EMAIL };
});

const rows = <T = Record<string, unknown>>(code: string, sql: string) =>
  runInDurableObject(env.PARTY.getByName(code), async (_i, state) => state.storage.sql.exec(sql).toArray() as T[]);

/** A party with a host, a guest and two invites, ready to draw. */
async function partyWithInvites() {
  const host = await signIn(uniqueEmail('host'), 'Host');
  const guest = await signIn(uniqueEmail('guest'), 'Guest');
  const { code } = await createParty(host.token);
  await quietMail(code);
  await join(guest.token, code);
  await invite(host.token, code, [uniqueEmail('a'), uniqueEmail('b')]);
  await drainOutbox(code);
  return { host, guest, code };
}

describe('a drawn party lets go of emails', () => {
  it('deletes its invites at the draw, and its members\' emails once the draw is delivered; everything else still works', async () => {
    const { host, guest, code } = await partyWithInvites();
    expect(await rows(code, 'SELECT email FROM invites')).toHaveLength(2);
    await request('POST', '/v1/parties/draw', { token: host.token, body: { code } });
    expect(await rows(code, 'SELECT email FROM invites')).toEqual([]);
    await drainOutbox(code);
    expect(await rows(code, 'SELECT member_email FROM memberships')).toEqual([{ member_email: null }, { member_email: null }]);

    // Members still see their target, and their lists still have the party.
    expect((await request('GET', `/v1/parties?code=${code}`, { token: guest.token })).body.target).toEqual({ name: 'Host' });
    expect((await request('GET', '/v1/me/parties', { token: guest.token })).body.items).toMatchObject([{ code, isClosed: true }]);
    // Deleting an account still anonymizes the member, by id.
    expect(await env.PARTY.getByName(code).forgetMember(guest.id, guest.email)).toBe('anonymized');
  });

  it('keeps members\' emails while the outbox still has something to deliver, and copes with parties from before the outbox', async () => {
    const { host, code } = await partyWithInvites();
    await request('POST', '/v1/parties/draw', { token: host.token, body: { code } });
    await drainOutbox(code);
    await runInDurableObject(env.PARTY.getByName(code), async (instance: PartyDO, state) => {
      const sql = state.storage.sql;
      const tidy = () => (instance as unknown as { tidy(): void }).tidy();
      sql.exec("UPDATE memberships SET member_email = 'kept@example.com'");
      sql.exec("INSERT INTO outbox (payload, next_attempt_at) VALUES ('{\"kind\":\"mail.partyNotification\",\"email\":\"x@example.com\"}', 0)");
      tidy();
      expect(sql.exec('SELECT DISTINCT member_email FROM memberships').toArray()).toEqual([{ member_email: 'kept@example.com' }]);
      sql.exec('DROP TABLE outbox');
      tidy();
      expect(sql.exec('SELECT DISTINCT member_email FROM memberships').toArray()).toEqual([{ member_email: null }]);
      sql.exec(`CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL)`);
    });
  });
});

describe('invited addresses are kept for a day only', () => {
  it('deletes them once the day is over, wakes up to do it, and still counts every invite sent against the cap', async () => {
    const { host, code } = await partyWithInvites();
    const alarm = await runInDurableObject(env.PARTY.getByName(code), async (_i, state) => state.storage.getAlarm());
    const [{ at }] = await rows<{ at: number }>(code, 'SELECT MIN(invited_at) AS at FROM invites');
    expect(alarm).toBe(at + REINVITE_AFTER_MS);

    await runInDurableObject(env.PARTY.getByName(code), async (_i, state) => {
      state.storage.sql.exec('UPDATE invites SET invited_at = invited_at - ?', REINVITE_AFTER_MS);
    });
    await drainOutbox(code); // the alarm, as when the day is over
    expect(await rows(code, 'SELECT email FROM invites')).toEqual([]);
    expect((await invite(host.token, code, [uniqueEmail('c')])).body.invitesLeft).toBe(MAX_PARTY_INVITES - 3);
  });

  it('moves the cap to a counter for parties from before it, from the invites they kept', async () => {
    const { code } = await partyWithInvites();
    await runInDurableObject(env.PARTY.getByName(code), async (instance: PartyDO, state) => {
      const sql = state.storage.sql;
      sql.exec('ALTER TABLE party DROP COLUMN invites_sent');
      sql.exec('UPDATE invites SET sent = 3');
      (instance as unknown as { schemaReady: boolean }).schemaReady = false;
    });
    expect(await env.PARTY.getByName(code).view()).not.toBeNull(); // the next read migrates
    expect(await rows(code, 'SELECT invites_sent FROM party')).toEqual([{ invites_sent: 6 }]);
  });
});

describe('a user object lets go of emails', () => {
  it('blanks the email of a deleted account, and a new sign-in on top of it works', async () => {
    const who = await signIn(uniqueEmail('gone'), 'Gone');
    const user = env.USER.getByName(who.email);
    await user.tombstone();
    const [row] = await runInDurableObject(user, async (_i, state) => state.storage.sql.exec('SELECT email, name FROM user').toArray());
    expect(row).toEqual({ email: '', name: '' });
    expect(await user.ensure(who.email)).toMatchObject({ email: who.email });
  });

  it('deletes expired link and request records when it starts', async () => {
    const who = await signIn(uniqueEmail('links'));
    const user = env.USER.getByName(who.email);
    const tables = ['used_magic_links', 'mail_requests', 'create_requests', 'host_reservations'];
    await runInDurableObject(user, async (_i, state) => {
      const sql = state.storage.sql;
      sql.exec("INSERT INTO used_magic_links (jti, expires_at, outcome) VALUES ('old', 1, 'new@example.com'), ('fresh', ?, NULL)", Date.now() + 60_000);
      sql.exec("INSERT INTO mail_requests (key, detail, expires_at) VALUES ('old', 'new@example.com', 1)");
      sql.exec("INSERT INTO create_requests (key, party_id, slug, expires_at, detail) VALUES ('old', 'p', 'S', 1, 'Party')");
      sql.exec("INSERT INTO host_reservations (id, expires_at) VALUES ('old', 1)");
    });
    await evictDurableObject(user);
    await user.get(); // starts it again
    const left = await runInDurableObject(user, async (_i, state) =>
      tables.map(table => state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n));
    expect(left).toEqual([1, 0, 0, 0]);
  });
});
