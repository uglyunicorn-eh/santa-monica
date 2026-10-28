import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { mailRef } from 'src/utils/logRef';
import { MAX_PARTY_INVITES, REINVITE_AFTER_MS } from 'src/do/PartyDO';

import { PartyInviteToken } from 'src/api/types';

import { denied, drainOutbox, jwt, mailer, request, signIn, testEnv, uniqueEmail } from './helpers';

const createParty = async (token: string, password?: string) =>
  (await request('POST', '/v1/parties', { token, body: { name: 'Office party', ...(password ? { password } : {}) } })).body;

/** Records what the party emails (its own EMAIL binding, used when its outbox delivers). */
const partyMailer = async (code: string) => {
  const { sent, EMAIL } = mailer();
  await runInDurableObject(env.PARTY.getByName(code), async instance => {
    const self = instance as unknown as { env: object };
    self.env = { ...self.env, EMAIL };
  });
  return sent;
};

const invite = (token: string, code: string, emails: string[], e?: typeof env) =>
  request('POST', '/v1/parties/invite', { token, body: { code, emails }, env: e });

describe('POST /v1/parties/invite', () => {
  it('emails each new address once, skipping members and repeats, and never sends the secret phrase', async () => {
    const host = await signIn(uniqueEmail('host'), 'Santa Host');
    const guest = await signIn(uniqueEmail('guest'), 'Guest');
    const party = await createParty(host.token, 'Jingle bells');
    await request('POST', '/v1/parties/join', { token: guest.token, body: { code: party.code, name: 'Guest', password: 'Jingle bells' } });
    const sent = await partyMailer(party.code);
    const e = testEnv();
    const [a, b] = [uniqueEmail('a'), uniqueEmail('b')];

    const first = await invite(host.token, party.code, [a.toUpperCase(), b, b, guest.email], e);
    expect(first).toMatchObject({
      status: 200,
      body: { invited: [a, b], alreadyInvited: [], alreadyJoined: [guest.email], invitesLeft: MAX_PARTY_INVITES - 2 },
    });
    await drainOutbox(party.code);
    expect(sent.map(m => m.to).sort()).toEqual([a, b].sort());
    expect(sent[0].subject).toBe("You're invited to a Secret Santa party!");
    expect(sent[0].text).toContain('Santa Host invites you to Office party');
    expect(sent[0].text).toContain(`/p/${party.code}/`);
    // The link carries a single-use invite for that address and party, after "#".
    const link = /\/p\/[A-Z]+\/#([\w-]+(?:\.[\w-]*){4})/.exec(sent[0].text)![1];
    expect(await jwt().jwtVerify<PartyInviteToken>(link, 'PartyInvite')).toMatchObject({ email: sent[0].to, party: party.code, jti: expect.any(String) });
    expect(sent[0].text).toContain('ask Santa Host for it');
    expect(sent[0].text).not.toContain('Jingle bells');

    // Asking again within a day sends nothing.
    expect((await invite(host.token, party.code, [a], e)).body).toMatchObject({ invited: [], alreadyInvited: [a] });
    await drainOutbox(party.code);
    expect(sent).toHaveLength(2);

    // After a day, the address can be invited again.
    await runInDurableObject(env.PARTY.getByName(party.code), async (_i, state) => {
      state.storage.sql.exec('UPDATE invites SET invited_at = invited_at - ?', REINVITE_AFTER_MS);
    });
    expect((await invite(host.token, party.code, [a], e)).body).toMatchObject({ invited: [a], invitesLeft: MAX_PARTY_INVITES - 3 });
  });

  it('is for the host of an open party only', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const guest = await signIn(uniqueEmail('guest'), 'Guest');
    const party = await createParty(host.token);
    await request('POST', '/v1/parties/join', { token: guest.token, body: { code: party.code, name: 'Guest' } });
    expect(await invite(host.token, 'QQQQQQQQ', [uniqueEmail()])).toMatchObject({ status: 404, body: { error: { code: 'not_found', field: 'party' } } });
    expect(await invite(guest.token, party.code, [uniqueEmail()])).toMatchObject({ status: 403, body: { error: { code: 'forbidden', field: 'party' } } });

    await request('POST', '/v1/parties/draw', { token: host.token, body: { code: party.code } });
    expect(await invite(host.token, party.code, [uniqueEmail()])).toMatchObject({ status: 409, body: { error: { code: 'conflict' } } });
  });

  it('takes 1 to 10 valid addresses', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const party = await createParty(host.token);
    expect(await invite(host.token, party.code, [])).toMatchObject({ status: 400 });
    expect(await invite(host.token, party.code, ['not an email'])).toMatchObject({ status: 400 });
    expect(await invite(host.token, party.code, Array.from({ length: 11 }, () => uniqueEmail()))).toMatchObject({ status: 400 });
  });

  it(`sends at most ${MAX_PARTY_INVITES} invites per party`, async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const party = await createParty(host.token);
    const some = (n: number) => invite(host.token, party.code, Array.from({ length: n }, () => uniqueEmail()));
    const refused = (message: string) => ({ status: 429, body: { error: { code: 'rate_limited', field: 'emails', message } } });
    for (const n of [10, 10, 10, 10, 5]) {
      expect((await some(n)).status).toBe(200);
    }
    expect(await some(10)).toMatchObject(refused('This party can send only 5 more invites.'));
    expect((await some(4)).body).toMatchObject({ invitesLeft: 1 });
    expect(await some(2)).toMatchObject(refused('This party can send only 1 more invite.'));
    expect((await some(1)).body).toMatchObject({ invitesLeft: 0 });
    expect(await some(1)).toMatchObject(refused('This party has sent all the invites it can. Share its link instead.'));
  });

  it('is rate limited per host', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const party = await createParty(host.token);
    expect(await invite(host.token, party.code, [uniqueEmail()], testEnv({ INVITE_RATE_LIMIT_USER: denied })))
      .toMatchObject({ status: 429, body: { error: { code: 'rate_limited', field: 'emails' } } });
  });

  it("drops an invite to an address that is over its email limit, or for a party that's gone, storing nothing for it", async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const party = await createParty(host.token);
    const sent = await partyMailer(party.code);
    const e = testEnv();
    const busy = uniqueEmail('busy');
    // The limit is the real binding inside the party: use it up for this address.
    const ref = await mailRef(env, busy);
    for (let i = 0; i < 3; i++) {
      await env.MAIL_RATE_LIMIT_ADDRESS.limit({ key: ref });
    }
    await invite(host.token, party.code, [busy], e);
    await drainOutbox(party.code);
    expect(sent).toHaveLength(0);
    // Nothing was stored for the address.
    expect(await runInDurableObject(env.USER.getByName(busy), async (_i, state) =>
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'").toArray())).toEqual([]);

    const other = await createParty(host.token);
    const otherSent = await partyMailer(other.code);
    await request('POST', '/v1/parties/delete', { token: host.token, body: { code: other.code } });
    // An invite still queued when the party was deleted.
    await runInDurableObject(env.PARTY.getByName(other.code), async (_i, state) => {
      state.storage.sql.exec('INSERT INTO outbox (payload, next_attempt_at) VALUES (?, ?)', JSON.stringify({
        kind: 'mail.partyInvite', email: uniqueEmail(), hostName: 'Host', partyName: 'P', slug: other.code, isProtected: false,
      }), Date.now());
    });
    await drainOutbox(other.code);
    expect(otherSent).toHaveLength(0);
  });
});
