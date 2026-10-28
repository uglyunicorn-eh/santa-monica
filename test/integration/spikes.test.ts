import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { ALL_MAIL } from 'src/api/rateLimit';
import { PartyDO } from 'src/do/PartyDO';
import { strToNodeId } from 'src/utils/strings/nodeId';

import { Person, call, createParty, joinParty, mailbox, requestDeletion, settleParty, signIn, uniqueEmail, uniqueIp, untilRefused } from './support';

// Plan section 2 (traffic spikes) and review fixes 1, 2 and 5. The run's view cache is off and its all-emails limit is
// wide open, so these tests send requests through the same app with those settings changed (`settings`).

const allowed = { limit: async () => ({ success: true }) } as unknown as RateLimit;
const denied = { limit: async () => ({ success: false }) } as unknown as RateLimit;

/** A rate limit that records the keys it was asked for. */
function counting() {
  const keys: string[] = [];
  return { keys, limit: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: true }; } } as unknown as RateLimit };
}

const cached = { PUBLIC_CACHE_MS: '60000' };

/** The raw user id the Durable Objects take (the API gives node ids). */
const userId = (person: { id: string }) => strToNodeId(person.id).id;

const lookUp = (code: string, options: { token?: string; settings?: object } = {}) =>
  call('POST', '/v1/parties/lookup', { body: { code }, token: options.token, settings: options.settings ?? cached });

describe('signed-out party views', () => {
  it('are kept in the Worker for signed-out visitors only, and a party that does not exist never is', async () => {
    const host = await signIn(uniqueEmail('host'));
    const guest = await signIn(uniqueEmail('guest'));
    const party = await createParty(host, 'Before');
    await joinParty(guest, party, 'Guest');
    // A lookup that starts in the same millisecond as a write keeps nothing (it may have read before the write).
    await new Promise(resolve => setTimeout(resolve, 5));
    expect((await lookUp(party.code)).body).toMatchObject({ name: 'Before', isClosed: false });
    // Drawn straight in the object, not through the Worker: the kept view doesn't know.
    await env.PARTY.getByName(party.code).close(userId(host));
    expect((await lookUp(party.code)).body).toMatchObject({ isClosed: false });
    // A signed-in lookup always asks the party.
    expect((await lookUp(party.code, { token: host.token })).body).toMatchObject({ isHost: true, isClosed: true });
    expect((await lookUp('QQQQQQQQ')).status).toBe(404);
  });

  // The default (PUBLIC_VIEW_MS) is checked in test/unit/guards.test.ts.
  it('expire after the time set in PUBLIC_CACHE_MS', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host, 'Short');
    const brief = { PUBLIC_CACHE_MS: '50' };
    await lookUp(party.code, { settings: brief });
    await env.PARTY.getByName(party.code).delete(userId(host));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect((await lookUp(party.code, { settings: brief })).status).toBe(404);
  });

  it('are forgotten after every party write through this Worker, whatever the write answers', async () => {
    const host = await signIn(uniqueEmail('host'));
    const guest = await signIn(uniqueEmail('guest'));
    const party = await createParty(host, 'Changing');
    const write = (path: string, who: Person, extra: object = {}) =>
      call('POST', `/v1/parties/${path}`, { token: who.token, body: { code: party.code, ...extra }, settings: cached });
    const seen = async () => (await lookUp(party.code)).body;

    await seen();
    await write('join', guest, { name: 'Guest' });
    await env.PARTY.getByName(party.code).delete(userId(host)); // behind the Worker's back
    expect((await lookUp(party.code)).status).toBe(404);  // the join forgot the view, so this saw the delete
    await env.PARTY.getByName(party.code).restore(userId(host));
    expect((await seen()).isClosed).toBe(false);
    await write('invite', host, { emails: [uniqueEmail('invited')] });
    await write('leave', guest);
    await write('join', guest, { name: 'Guest' });
    expect((await write('draw', host)).status).toBe(200);
    expect((await seen()).isClosed).toBe(true);
    // A refused write forgets it too.
    expect((await write('delete', host)).status).toBe(409);
    expect((await seen()).isClosed).toBe(true);

    const other = await signIn(uniqueEmail('other'));
    const open = await createParty(other, 'Going');
    const writeOpen = (path: string) => call('POST', `/v1/parties/${path}`, { token: other.token, body: { code: open.code }, settings: cached });
    await lookUp(open.code);
    await writeOpen('delete');
    expect((await lookUp(open.code)).status).toBe(404);
    await writeOpen('restore');
    expect((await lookUp(open.code)).status).toBe(200);
  });

  it('are forgotten for the parties an account deletion erases', async () => {
    const host = await signIn(uniqueEmail('leaving'));
    const party = await createParty(host, 'Erased');
    expect((await lookUp(party.code)).status).toBe(200);
    const link = await requestDeletion(host);
    expect((await call('POST', '/v1/me/deletion/confirm', { body: { token: link }, settings: cached })).status).toBe(200);
    expect((await lookUp(party.code)).status).toBe(404);
  });
});

describe('the limit on all emails together', () => {
  it('refuses a sign-in link or an account link with 429, sending nothing', async () => {
    const email = uniqueEmail('over');
    expect(await call('POST', '/v1/auth/magic-link', { body: { email }, settings: { MAIL_RATE_LIMIT_ALL: denied } })).toMatchObject({
      status: 429, body: { error: { code: 'rate_limited', field: 'email' } },
    });
    expect(await mailbox(email)).toEqual([]);
    const who = await signIn(uniqueEmail('account'));
    const before = (await mailbox(who.email)).length;
    expect((await call('POST', '/v1/me/deletion', { token: who.token, settings: { MAIL_RATE_LIMIT_ALL: denied } })).status).toBe(429);
    expect(await mailbox(who.email)).toHaveLength(before);
  });

  it('is taken only for an email about to be sent: not for an unknown party code, nor an address over its limit', async () => {
    const all = counting();
    const settings = { MAIL_RATE_LIMIT_ALL: all.limit };
    expect((await call('POST', '/v1/auth/magic-link', { body: { email: uniqueEmail(), party: 'QQQQQQQQ' }, settings })).status).toBe(404);
    // Three a minute per address: the fourth is refused before the all-emails limit.
    const busy = uniqueEmail('busy');
    const answers = await untilRefused(3, () => call('POST', '/v1/auth/magic-link', { body: { email: busy }, ip: uniqueIp(), settings }));
    expect(answers.at(-1)!.status).toBe(429);
    // Taken once per email that went out, and not for the refused one.
    const sent = answers.filter(a => a.status === 202).length;
    expect(sent).toBeGreaterThanOrEqual(3);
    expect(all.keys).toEqual(Array(sent).fill(ALL_MAIL));
  });

  it('holds party invites back until there is room, without counting them against their address twice', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host, 'Invites');
    await settleParty(party.code);
    const invited = uniqueEmail('invited');
    await runInDurableObject(env.PARTY.getByName(party.code), async (_i, state) => {
      state.storage.sql.exec('INSERT INTO outbox (payload, next_attempt_at) VALUES (?, 0)', JSON.stringify({
        kind: 'mail.partyInvite', email: invited, hostName: 'Host', partyName: 'Invites', slug: party.code, isProtected: false,
      }));
    });
    // What the invite counted against its address's limit.
    const counted: string[] = [];
    const address = { limit: async ({ key }: { key: string }) => { counted.push(key); return { success: true }; } } as unknown as RateLimit;
    const deliverWith = (limit: RateLimit) => runInDurableObject(env.PARTY.getByName(party.code), async (instance: PartyDO, state) => {
      const original = (instance as any).env;
      (instance as any).env = { ...original, MAIL_RATE_LIMIT_ALL: limit, MAIL_RATE_LIMIT_ADDRESS: address };
      try {
        await (instance as any).runOutbox(() => true, true);
      } finally {
        (instance as any).env = original;
      }
      return state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox').one().n;
    });
    const sent = async () => counted.length;
    expect(await deliverWith(denied)).toBe(1);
    expect(await mailbox(invited)).toEqual([]);
    expect(await deliverWith(allowed)).toBe(0);
    expect((await mailbox(invited)).map(m => m.subject)).toHaveLength(1);
    expect(await sent()).toBe(1);
  });
});

