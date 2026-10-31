import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { EnterRequestToken, PartySignInToken, UserToken } from 'src/api/types';
import { PARTY_SIGN_IN_TTL } from 'src/do/PartyDO';

import { Sent, browserJwk, jwt, mailer, request, signIn, testEnv, tokenIn, uniqueEmail } from './helpers';

type Who = { nodeId: string; email: string };

const createParty = async (token: string) => (await request('POST', '/v1/parties', { token, body: { name: 'Link party' } })).body;
const join = (token: string, code: string) => request('POST', '/v1/parties/join', { token, body: { code, name: 'Guest' } });

/** A party's sign-in link, the way its emails make one. */
const memberLink = (who: Who, party: string, ttl = 60, jti: string = crypto.randomUUID()) =>
  jwt().issueToken<PartySignInToken>('PartySignIn', { sub: who.nodeId, email: who.email, party, jti }, { ttl });

const useLink = (token: string, key?: string, extra: Record<string, unknown> = {}) =>
  request('POST', '/v1/auth/party-link', { body: { token, ...extra }, key });

const notMember = { status: 403, body: { error: { code: 'not_member', field: 'token' } } };
const busy = { status: 409, body: { error: { code: 'account_busy', field: 'token' } } };

const again = (token: string, EMAIL?: SendEmail) =>
  request('POST', '/v1/auth/magic-link/again', { body: { token }, env: testEnv(EMAIL ? { EMAIL } : {}) });

/** Holds the account at `email` the way an email change or deletion does while it runs. */
const holdAccount = (email: string) => runInDurableObject(env.USER.getByName(email), async (_i, state) => {
  state.storage.sql.exec('UPDATE user SET changing_until = ?', Date.now() + 60_000);
});

const tablesOf = (email: string) => runInDurableObject(env.USER.getByName(email), async (_i, state) =>
  state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'").toArray());

/** Runs the party's alarm with its email captured, until its outbox is empty, and returns what it sent. */
async function deliver(code: string): Promise<Sent> {
  const { sent, EMAIL } = mailer();
  const stub = env.PARTY.getByName(code);
  await runInDurableObject(stub, async instance => {
    (instance as unknown as { env: object }).env = { ...(instance as unknown as { env: object }).env, EMAIL };
  });
  // At least once: the alarm queues the reminder itself.
  for (let i = 0; i < 10 && (i === 0 || await stub.pendingOutbox()); i++) {
    await runInDurableObject(stub, async (_i, state) => state.storage.setAlarm(Date.now()));
    await runDurableObjectAlarm(stub);
  }
  return sent;
}

describe('POST /v1/auth/party-link', () => {
  it("signs the member in, bound to the browser's key, and returns the party", async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const guest = await signIn(uniqueEmail('guest'), 'Guest');
    const party = await createParty(host.token);
    await join(guest.token, party.code);

    const signedIn = await useLink(await memberLink(guest, party.code), crypto.randomUUID(), { key: await browserJwk() });
    expect(signedIn).toMatchObject({ status: 200, body: { party: party.code, user: { id: guest.nodeId, email: guest.email }, expiresAt: expect.any(String) } });
    expect((await jwt().jwtVerify<UserToken>(signedIn.body.userToken, 'UserToken')).cnf?.jkt).toEqual(expect.any(String));
  });

  it('works once; the same request signs in again, any other (with a key or without) is link_used', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host.token);
    const token = await memberLink(host, party.code);
    const key = crypto.randomUUID();
    expect((await useLink(token, key)).status).toBe(200);
    expect(await useLink(token, key)).toMatchObject({ status: 200, body: { user: { id: host.nodeId } } });
    for (const other of [crypto.randomUUID(), undefined]) {
      expect(await useLink(token, other)).toMatchObject({ status: 409, body: { error: { code: 'link_used', field: 'token' } } });
    }
  });

  it('is not_member for someone not in the party, or a party that never was, and stores nothing', async () => {
    const host = await signIn(uniqueEmail('host'));
    const stranger = await signIn(uniqueEmail('stranger'));
    const party = await createParty(host.token);
    const token = await memberLink(stranger, party.code);
    expect(await useLink(token)).toMatchObject(notMember);
    expect(await useLink(await memberLink(host, 'QWERTYUI'))).toMatchObject(notMember);
    // Still unused: once they join, it works.
    await join(stranger.token, party.code);
    expect((await useLink(token)).status).toBe(200);
  });

  it("is not_member when the address holds no account, or another one, and makes or records nothing there", async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host.token);

    const nobody = uniqueEmail('nobody');
    expect(await useLink(await memberLink({ nodeId: host.nodeId, email: nobody }, party.code))).toMatchObject(notMember);
    expect(await tablesOf(nobody)).toEqual([]);

    const other = await signIn(uniqueEmail('other'));
    const jti = crypto.randomUUID();
    expect(await useLink(await memberLink({ nodeId: host.nodeId, email: other.email }, party.code, 60, jti))).toMatchObject(notMember);
    expect(await runInDurableObject(env.USER.getByName(other.email), async (_i, state) =>
      state.storage.sql.exec('SELECT jti FROM used_magic_links WHERE jti = ?', jti).toArray())).toEqual([]);
    expect(await env.USER.getByName(other.email).get()).toMatchObject({ id: other.id });

    // A deleted account at the address is no one's.
    const gone = await signIn(uniqueEmail('gone'));
    await join(gone.token, party.code);
    await env.USER.getByName(gone.email).tombstone();
    expect(await useLink(await memberLink(gone, party.code))).toMatchObject(notMember);
  });

  it('signs in an account that has moved from the spelling the party keeps to the normalized one', async () => {
    const typed = uniqueEmail('Mixed.Case');
    const member = await signIn(typed.toLowerCase());
    const party = await createParty(member.token);
    const token = await memberLink({ nodeId: member.nodeId, email: typed }, party.code);
    expect(await useLink(token)).toMatchObject({ status: 200, body: { party: party.code, user: { id: member.nodeId } } });
    expect(await useLink(token)).toMatchObject({ status: 409, body: { error: { code: 'link_used' } } });
    expect(await tablesOf(typed)).toEqual([]);
  });

  it('is account_busy while the account is being changed, and left unused for after', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host.token);
    const token = await memberLink(host, party.code);
    await holdAccount(host.email);
    expect(await useLink(token)).toMatchObject(busy);
    await runInDurableObject(env.USER.getByName(host.email), async (_i, state) => {
      state.storage.sql.exec('UPDATE user SET changing_until = NULL');
    });
    expect((await useLink(token)).status).toBe(200);
  });

  it('signs in the host of a deleted party while it can be restored, and nobody else', async () => {
    const host = await signIn(uniqueEmail('host'));
    const guest = await signIn(uniqueEmail('guest'));
    const party = await createParty(host.token);
    await join(guest.token, party.code);
    await request('POST', '/v1/parties/delete', { token: host.token, body: { code: party.code } });

    expect(await useLink(await memberLink(guest, party.code))).toMatchObject(notMember);
    expect((await useLink(await memberLink(host, party.code))).status).toBe(200);
    await runInDurableObject(env.PARTY.getByName(party.code), async (_i, state) => {
      state.storage.sql.exec('UPDATE party SET restorable_until = ?', Date.now() - 1000);
    });
    expect(await useLink(await memberLink(host, party.code))).toMatchObject(notMember);
  });

  it('refuses an expired link, another kind of token, and garbage', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host.token);
    expect(await useLink(await memberLink(host, party.code, -60))).toMatchObject({ status: 400, body: { error: { code: 'link_expired', field: 'token' } } });
    const invite = await jwt().issueToken('PartyInvite', { email: host.email, party: party.code, jti: crypto.randomUUID() }, { ttl: 60 });
    for (const token of [invite, 'garbage']) {
      expect(await useLink(token)).toMatchObject({ status: 400, body: { error: { code: 'invalid_link', field: 'token' } } });
    }
  });
});

describe('POST /v1/auth/magic-link/again with a party sign-in link', () => {
  it('emails a magic link for the party to the normalized address, keeping the one the party had as typed', async () => {
    const typed = uniqueEmail('Mixed.Case');
    const member = await signIn(typed.toLowerCase());
    const party = await createParty(member.token);
    const { sent, EMAIL } = mailer();
    expect((await again(await memberLink({ nodeId: member.nodeId, email: typed }, party.code, -3600), EMAIL)).status).toBe(202);
    expect(sent.map(m => m.to)).toEqual([typed.toLowerCase()]);
    expect(await jwt().jwtVerify<EnterRequestToken>(tokenIn(sent[0].text), 'EnterRequest'))
      .toMatchObject({ email: typed.toLowerCase(), typed, party: party.code });
  });

  it('sends nothing when the account is no longer at the address, or is being changed', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host.token);
    const { sent, EMAIL } = mailer();

    // The address the party kept after an email change: a magic link there would make a new, empty account.
    const nobody = uniqueEmail('moved-away');
    expect(await again(await memberLink({ nodeId: host.nodeId, email: nobody }, party.code, -60), EMAIL)).toMatchObject(notMember);
    expect(await tablesOf(nobody)).toEqual([]);

    await holdAccount(host.email);
    expect(await again(await memberLink(host, party.code, -60), EMAIL)).toMatchObject(busy);
    expect(sent).toEqual([]);
  });
});

describe("the party's emails", () => {
  it('carry a link that signs in the member: 7 days in the "dice are rolled" email (not sent to the host), 3 in the reminder', async () => {
    const host = await signIn(uniqueEmail('host'));
    const guest = await signIn(uniqueEmail('guest'));
    const party = await createParty(host.token);
    await join(guest.token, party.code);
    await request('POST', '/v1/parties/draw', { token: host.token, body: { code: party.code } });
    const rolled = (await deliver(party.code)).filter(m => m.subject.endsWith('the dice are rolled!'));
    // The host just rolled and sees their match on the page, so only the guest is emailed.
    expect(rolled.map(m => m.to)).toEqual([guest.email]);
    const [mail] = rolled;
    expect(mail.text).toContain(`https://gnomik.me/p/${party.code}/sign-in#`);
    expect(mail.text).toContain("please don't forward this email");
    const rolledLink = await jwt().jwtVerify<PartySignInToken>(tokenIn(mail.text), 'PartySignIn');
    expect(rolledLink).toMatchObject({ sub: guest.nodeId, email: guest.email, party: party.code, jti: expect.any(String) });
    expect(rolledLink.exp! - rolledLink.iat!).toBe(PARTY_SIGN_IN_TTL.rolled);

    const due = await createParty(host.token);
    await runInDurableObject(env.PARTY.getByName(due.code), async (_i, state) => {
      state.storage.sql.exec('UPDATE party SET due_at = ?, remind_at = ?', Date.now() + 24 * 60 * 60 * 1000, Date.now() - 1000);
    });
    const [reminder] = await deliver(due.code);
    expect(reminder.subject).toBe('Link party starts in about a day');
    expect(reminder.text).toContain("you're ready. The button signs you in, so please don't forward this email.");
    const link = await jwt().jwtVerify<PartySignInToken>(tokenIn(reminder.text), 'PartySignIn');
    expect(link).toMatchObject({ sub: host.nodeId, email: host.email, party: due.code });
    expect(link.exp! - link.iat!).toBe(PARTY_SIGN_IN_TTL.due);
  });

  it('link to the bare party page from a message queued before links existed', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host.token);
    await runInDurableObject(env.PARTY.getByName(party.code), async instance => {
      const queue = instance as unknown as { enqueue(message: object): void };
      queue.enqueue({ kind: 'mail.partyNotification', email: host.email, partyName: 'Link party', slug: party.code });
      queue.enqueue({ kind: 'mail.partyDue', email: host.email, partyName: 'Link party', slug: party.code, members: 1 });
    });
    const sent = await deliver(party.code);
    expect(sent).toHaveLength(2);
    for (const mail of sent) {
      expect(mail.text).toContain(`https://gnomik.me/p/${party.code}/`);
      expect(mail.text).not.toContain('sign-in');
      // Nor does it say the button signs in.
      expect(mail.text).not.toContain('signs you in');
    }
  });
});
