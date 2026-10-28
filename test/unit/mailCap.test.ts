import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { forgetRequests } from 'src/api/requestMemo';
import { isPermanentMailError, recipientAllowed } from 'src/mail';
import { mailRef } from 'src/utils/logRef';

import { denied, mailer, request, signIn, testEnv, uniqueEmail } from './helpers';

const key = () => crypto.randomUUID();

/** A per-address limit that records the keys it was asked for, refusing the ones in `refuse`. */
function addressLimit(refuse: string[] = []) {
  const keys: string[] = [];
  return { keys, limit: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: !refuse.includes(key) }; } } as unknown as RateLimit };
}

/** What a user object has stored: its tables, leaving out the runtime's own. */
const storedTables = (email: string) => runInDurableObject(env.USER.getByName(email), async (_i, state) =>
  state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'").toArray().map(r => r.name));

const overLimit = { status: 429, body: { error: { code: 'rate_limited' } } };

describe('the per-address email limit', () => {
  afterEach(forgetRequests);

  const magicLink = (email: string, options: { key?: string; e?: typeof env; party?: string } = {}) =>
    request('POST', '/v1/auth/magic-link', { body: { email, ...(options.party ? { party: options.party } : {}) }, key: options.key, env: options.e });

  it('counts each address by its hash, never the address itself, for sign-in, account and email-change links', async () => {
    const address = addressLimit();
    const e = testEnv({ MAIL_RATE_LIMIT_ADDRESS: address.limit });
    const email = uniqueEmail('hashed');
    expect((await magicLink(email, { e })).status).toBe(202);
    const who = await signIn(uniqueEmail('account'), 'Account');
    expect((await request('POST', '/v1/me/deletion', { token: who.token, env: e })).status).toBe(202);
    const newEmail = uniqueEmail('new');
    expect((await request('POST', '/v1/me/email-change', { token: who.token, body: { email: newEmail }, env: e })).status).toBe(202);
    expect(address.keys).toEqual([await mailRef(env, email), await mailRef(env, who.email), await mailRef(env, newEmail)]);
    expect(address.keys.join()).not.toContain('@');
  });

  it('refuses a sign-in link, an account link or an email-change link over it', async () => {
    const e = testEnv({ MAIL_RATE_LIMIT_ADDRESS: denied });
    expect(await magicLink(uniqueEmail(), { e })).toMatchObject({ ...overLimit, body: { error: { field: 'email' } } });
    const who = await signIn(uniqueEmail('account'), 'Account');
    expect(await request('POST', '/v1/me/deletion', { token: who.token, env: e })).toMatchObject(overLimit);
    expect(await request('POST', '/v1/me/email-change', { token: who.token, body: { email: uniqueEmail('new') }, env: e })).toMatchObject(overLimit);
  });

  it('never holds back the notice of an email change to the current address', async () => {
    const { sent, EMAIL } = mailer();
    const who = await signIn(uniqueEmail('owner'), 'Owner');
    // The current address is over its limit; the new one isn't.
    const address = addressLimit([await mailRef(env, who.email)]);
    const newEmail = uniqueEmail('new');
    expect((await request('POST', '/v1/me/email-change', { token: who.token, body: { email: newEmail }, env: testEnv({ EMAIL, MAIL_RATE_LIMIT_ADDRESS: address.limit }) })).status).toBe(202);
    expect(sent.map(m => m.to).sort()).toEqual([newEmail, who.email].sort());
    expect(address.keys).toEqual([await mailRef(env, newEmail)]);
  });

  it('answers a repeated sign-in request from memory: one email, one count', async () => {
    const { sent, EMAIL } = mailer();
    const address = addressLimit();
    const e = testEnv({ EMAIL, MAIL_RATE_LIMIT_ADDRESS: address.limit });
    const email = uniqueEmail('repeat');
    const k = key();
    for (let i = 0; i < 3; i++) {
      expect((await magicLink(email, { key: k, e })).status).toBe(202);
    }
    expect(sent).toHaveLength(1);
    expect(address.keys).toHaveLength(1);
    // The same key for another party is a new request.
    const host = await signIn(uniqueEmail('host'), 'Host');
    const { body: party } = await request('POST', '/v1/parties', { token: host.token, body: { name: 'P' } });
    expect((await magicLink(email, { key: k, e, party: party.code })).status).toBe(202);
    expect(sent).toHaveLength(2);
  });

  it("remembers nothing for a request whose email didn't go out, so a retry sends it", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let down = true;
    const { sent, EMAIL } = mailer(() => down);
    const e = testEnv({ EMAIL });
    const email = uniqueEmail('retry');
    const k = key();
    expect((await magicLink(email, { key: k, e })).status).toBe(503);
    down = false;
    expect((await magicLink(email, { key: k, e })).status).toBe(202);
    expect(sent).toHaveLength(1);
    error.mockRestore();
  });

  it('takes one count, and only one, for a request the all-emails limit refuses', async () => {
    const address = addressLimit();
    expect((await magicLink(uniqueEmail('spike'), { e: testEnv({ MAIL_RATE_LIMIT_ADDRESS: address.limit, MAIL_RATE_LIMIT_ALL: denied }) })).status).toBe(429);
    expect(address.keys).toHaveLength(1);
  });
});

describe('nothing stored before a sign-in link is used', () => {
  it('leaves no stored object for a magic-link request, and makes the account only when the link is used', async () => {
    const { sent, EMAIL } = mailer();
    const email = uniqueEmail('not-yet');
    expect((await request('POST', '/v1/auth/magic-link', { body: { email }, key: key(), env: testEnv({ EMAIL }) })).status).toBe(202);
    expect(await storedTables(email)).toEqual([]);
    const link = /#([\w-]+(?:\.[\w-]*){4})/.exec(sent[0].text)![1];
    expect((await request('POST', '/v1/auth/session', { body: { token: link } })).status).toBe(200);
    expect(await storedTables(email)).toContain('user');
  });

  it('leaves no stored object for an email-change request to a new address, or a look at whether it is taken', async () => {
    const who = await signIn(uniqueEmail('mover'), 'Mover');
    const newEmail = uniqueEmail('elsewhere');
    expect((await request('POST', '/v1/me/email-change', { token: who.token, body: { email: newEmail } })).status).toBe(202);
    expect(await storedTables(newEmail)).toEqual([]);
    expect(await env.USER.getByName(newEmail).get()).toBeNull();
    expect(await env.USER.getByName(newEmail).listParties(10)).toEqual([]);
    expect(await env.USER.getByName(newEmail).checkAccountChange('x', 'y')).toBe('gone');
    expect(await env.USER.getByName(newEmail).pendingOutbox()).toBe(0);
    await env.USER.getByName(newEmail).releaseMailRequest('k', '');
    expect(await storedTables(newEmail)).toEqual([]);
  });

  it('keeps the old count table out of objects that had one', async () => {
    const who = await signIn(uniqueEmail('old'), 'Old');
    await runInDurableObject(env.USER.getByName(who.email), async (instance, state) => {
      state.storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_sent (at INTEGER NOT NULL)');
      (instance as any).setUp();
    });
    expect(await storedTables(who.email)).not.toContain('mail_sent');
  });
});

describe('the email allowlist (PR previews)', () => {
  it('matches whole addresses and @domains, in any case; no list means anyone', () => {
    const list = ' tester@Example.com , @Team.test ,';
    expect(recipientAllowed(undefined, 'anyone@example.org')).toBe(true);
    expect(['tester@example.com', 'TESTER@example.com', 'a@team.test', 'b@TEAM.TEST'].map(to => recipientAllowed(list, to))).toEqual([true, true, true, true]);
    expect(['other@example.com', 'a@team.test.evil.example', 'a@notteam.test', 'tester@example.com.evil'].map(to => recipientAllowed(list, to))).toEqual([false, false, false, false]);
    expect(recipientAllowed('', 'tester@example.com')).toBe(false);
  });

  it("sends nothing to anyone else, and the outbox doesn't retry it", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { sent, EMAIL } = mailer();
    const preview = testEnv({ EMAIL, EMAIL_ALLOWLIST: '@allowed.test' });
    expect((await request('POST', '/v1/auth/magic-link', { body: { email: uniqueEmail() }, env: preview })).status).toBe(503);
    expect((await request('POST', '/v1/auth/magic-link', { body: { email: `ok-${crypto.randomUUID().slice(0, 8)}@allowed.test` }, env: preview })).status).toBe(202);
    expect(sent.map(m => m.to.split('@')[1])).toEqual(['allowed.test']);
    expect(isPermanentMailError(Object.assign(new Error('x'), { code: 'E_RECIPIENT_NOT_ALLOWED' }))).toBe(true);
    error.mockRestore();
  });
});
