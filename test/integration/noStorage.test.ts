import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { mailRef } from 'src/utils/logRef';

import { call, createParty, mailbox, magicLinkToken, newKey, redeem, requestEmailChange, requestMagicLink, settleParty, signIn, uniqueEmail, uniqueIp } from './support';

// Plan section 6: nothing is stored for a sign-in request (or any email to an address without an account) until a
// link is used. The per-address limit is a Rate Limiting binding keyed by the address's hash.

/** The tables an address's user object holds, leaving out the runtime's own. */
const storedTables = (email: string) => runInDurableObject(env.USER.getByName(email), async (_i, state) =>
  state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'").toArray().map(r => r.name));

describe('nothing stored before a link is used', () => {
  it('for a magic-link request, a party invite or an email-change request to a new address', async () => {
    const signingIn = uniqueEmail('signing-in');
    expect((await requestMagicLink(signingIn, { key: newKey() })).status).toBe(202);
    expect(await mailbox(signingIn)).toHaveLength(1);
    expect(await storedTables(signingIn)).toEqual([]);

    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host, 'Invites');
    const invited = uniqueEmail('invited');
    await call('POST', '/v1/parties/invite', { token: host.token, body: { code: party.code, emails: [invited] } });
    await settleParty(party.code);
    expect(await mailbox(invited)).toHaveLength(1);
    expect(await storedTables(invited)).toEqual([]);

    const moving = await signIn(uniqueEmail('moving'));
    const newEmail = uniqueEmail('new-home');
    await requestEmailChange(moving, newEmail);
    expect(await storedTables(newEmail)).toEqual([]);
  });

  it('and the account appears only when the link is used', async () => {
    const email = uniqueEmail('later');
    await requestMagicLink(email);
    expect(await storedTables(email)).toEqual([]);
    expect((await redeem(magicLinkToken((await mailbox(email)).at(-1)!))).status).toBe(200);
    expect(await storedTables(email)).toEqual(expect.arrayContaining(['user', 'used_magic_links']));
  });
});

describe('the per-address email limit', () => {
  it('allows about 3 emails a minute to one address, counted by its hash, for sign-in links, invites and email-change links alike', async () => {
    const email = uniqueEmail('busy');
    // Two sign-in links, then an invite: the third email.
    for (let i = 0; i < 2; i++) {
      expect((await requestMagicLink(email, { ip: uniqueIp() })).status).toBe(202);
    }
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host, 'Busy');
    await call('POST', '/v1/parties/invite', { token: host.token, body: { code: party.code, emails: [email] } });
    await settleParty(party.code);
    expect(await mailbox(email)).toHaveLength(3);
    // The fourth is refused, whichever kind it is.
    expect((await requestMagicLink(email, { ip: uniqueIp() })).status).toBe(429);
    const who = await signIn(uniqueEmail('mover'));
    expect((await call('POST', '/v1/me/email-change', { token: who.token, body: { email } })).status).toBe(429);
    expect(await mailbox(email)).toHaveLength(3);
    // The binding is keyed by the hash: the address itself is never the key.
    const ref = await mailRef(env, email);
    expect(ref).toMatch(/^[0-9a-f]{32}$/);
    expect((await env.MAIL_RATE_LIMIT_ADDRESS.limit({ key: ref })).success).toBe(false);
  });

  it('never holds back the notice of an email change to the current address', async () => {
    const who = await signIn(uniqueEmail('owner'));
    // The current address uses up its limit.
    const ref = await mailRef(env, who.email);
    for (let i = 0; i < 3; i++) {
      await env.MAIL_RATE_LIMIT_ADDRESS.limit({ key: ref });
    }
    const before = (await mailbox(who.email)).length;
    const newEmail = uniqueEmail('new');
    expect((await call('POST', '/v1/me/email-change', { token: who.token, body: { email: newEmail } })).status).toBe(202);
    expect((await mailbox(who.email)).length).toBe(before + 1);
    expect(await mailbox(newEmail)).toHaveLength(1);
  });

  it('answers a repeated sign-in request with one email', async () => {
    const email = uniqueEmail('repeat');
    const key = newKey();
    for (let i = 0; i < 3; i++) {
      expect((await requestMagicLink(email, { key })).status).toBe(202);
    }
    expect(await mailbox(email)).toHaveLength(1);
  });

  it('answers a repeated account email request from what the account keeps', async () => {
    const who = await signIn(uniqueEmail('account'));
    const key = newKey();
    for (let i = 0; i < 2; i++) {
      expect((await call('POST', '/v1/me/deletion', { token: who.token, key })).status).toBe(202);
    }
    expect((await mailbox(who.email)).filter(m => m.text?.includes('/profile/delete'))).toHaveLength(1);
    const kept = await runInDurableObject(env.USER.getByName(who.email), async (_i, state) =>
      state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM mail_requests').one().n);
    expect(kept).toBe(1);
  });
});
