import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { EnterRequestToken, PartyInviteToken, UserToken } from 'src/api/types';
import { MAX_PARTY_MEMBERS, MAX_PHRASE_GUESSES } from 'src/do/PartyDO';
import { nodeIdToStr } from 'src/utils/strings/nodeId';

import { jwt, mailer, request, signIn, testEnv, uniqueEmail } from './helpers';

const createParty = async (token: string, password?: string) =>
  (await request('POST', '/v1/parties', { token, body: { name: 'Office party', ...(password ? { password } : {}) } })).body;

/** An invite link's token, the way the party's invite email makes one. */
const inviteLink = (email: string, party: string, ttl = 60, jti: string = crypto.randomUUID()) =>
  jwt().issueToken<PartyInviteToken>('PartyInvite', { email, party, jti }, { ttl });

const accept = (body: Record<string, unknown>, options: { key?: string; env?: typeof env } = {}) =>
  request('POST', '/v1/auth/invite', { body, key: options.key ?? crypto.randomUUID(), env: options.env });

const lookUp = (token: string, code: string) => request('POST', '/v1/parties/lookup', { token, body: { code } });

const tokenIn = (text: string) => /#([\w-]+(?:\.[\w-]*){4})/.exec(text)![1];

const browserJwk = async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey;
  return { kty, crv, x, y };
};

describe('POST /v1/auth/invite', () => {
  it('signs a new address in and joins the party in one step, with the name typed', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const party = await createParty(host.token);
    const email = uniqueEmail('new');

    const taken = await accept({ token: await inviteLink(email, party.code), name: '  Snow   Flake ', key: await browserJwk() });
    expect(taken).toMatchObject({ status: 200, body: { party: party.code, user: { email, name: '' }, expiresAt: expect.any(String) } });
    // The session is bound to the browser's key, like a magic link's.
    expect((await jwt().jwtVerify<UserToken>(taken.body.userToken, 'UserToken')).cnf?.jkt).toEqual(expect.any(String));

    // The account is made, joined, and gets the name it joined with as its profile name.
    const user = await env.USER.getByName(email).get();
    expect(user).toMatchObject({ email, name: 'Snow Flake' });
    expect(taken.body.user.id).toBe(nodeIdToStr({ kind: 'User', id: user!.id }));
    const session = await signIn(email);
    expect((await lookUp(session.token, party.code)).body).toMatchObject({ isJoined: true });
    expect((await lookUp(host.token, party.code)).body).toMatchObject({ participants: ['Host', 'Snow Flake'] });
  });

  it("joins an existing account, keeping its profile name; the party gets the name typed", async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const party = await createParty(host.token);
    const guest = await signIn(uniqueEmail('known'), 'Known Name');

    const taken = await accept({ token: await inviteLink(guest.email, party.code), name: 'Party Name' });
    expect(taken).toMatchObject({ status: 200, body: { party: party.code, user: { id: guest.nodeId, name: 'Known Name' } } });
    expect((await lookUp(guest.token, party.code)).body).toMatchObject({ isJoined: true });
    expect((await lookUp(host.token, party.code)).body).toMatchObject({ participants: ['Host', 'Party Name'] });
  });

  it('keeps the link when the secret phrase is wrong, so the person can try again', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const party = await createParty(host.token, 'Jingle bells');
    const email = uniqueEmail('phrase');
    const token = await inviteLink(email, party.code);

    expect(await accept({ token, name: 'Guest', password: 'wrong' })).toMatchObject({
      status: 403, body: { error: { code: 'forbidden', field: 'password' } },
    });
    expect(await accept({ token, name: 'Guest' })).toMatchObject({ status: 403, body: { error: { code: 'forbidden', field: 'password' } } });
    // Nothing was stored for the address.
    expect(await env.USER.getByName(email).get()).toBeNull();

    expect(await accept({ token, name: 'Guest', password: 'JINGLE BELLS' })).toMatchObject({ status: 200, body: { party: party.code } });
  });

  it('counts wrong phrases per invited address, like a member\'s', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const party = await createParty(host.token, 'Jingle bells');
    const token = await inviteLink(uniqueEmail('guesser'), party.code);
    for (let i = 0; i < MAX_PHRASE_GUESSES; i++) {
      expect((await accept({ token, name: 'Guest', password: `guess ${i}` })).status).toBe(403);
    }
    expect(await accept({ token, name: 'Guest', password: 'Jingle bells' })).toMatchObject({
      status: 429, body: { error: { code: 'rate_limited', field: 'password' } },
    });
    // Another invitee isn't held up.
    expect((await accept({ token: await inviteLink(uniqueEmail('other'), party.code), name: 'Other', password: 'Jingle bells' })).status).toBe(200);
  });

  it("doesn't sign a member in: it emails them a magic link for the party instead", async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const party = await createParty(host.token);
    const guest = await signIn(uniqueEmail('member'), 'Guest');
    await request('POST', '/v1/parties/join', { token: guest.token, body: { code: party.code, name: 'Guest' } });
    const { sent, EMAIL } = mailer();

    const token = await inviteLink(guest.email, party.code);
    expect(await accept({ token, name: 'Guest' }, { env: testEnv({ EMAIL }) })).toEqual({ status: 202, body: { ok: true }, headers: expect.anything() });
    // Without an Idempotency-Key too.
    expect((await request('POST', '/v1/auth/invite', { body: { token, name: 'Guest' }, env: testEnv({ EMAIL }) })).status).toBe(202);
    expect(sent.map(m => m.to)).toEqual([guest.email, guest.email]);
    const link = await jwt().jwtVerify<EnterRequestToken>(tokenIn(sent[0].text), 'EnterRequest');
    expect(link).toMatchObject({ email: guest.email, party: party.code });
  });

  it('signs in again for a repeat of the same request, and is used up for any other', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const party = await createParty(host.token);
    const email = uniqueEmail('repeat');
    const token = await inviteLink(email, party.code);
    const key = crypto.randomUUID();

    const first = await accept({ token, name: 'Guest' }, { key });
    const again = await accept({ token, name: 'Guest' }, { key });
    expect(again).toMatchObject({ status: 200, body: { party: party.code, user: { id: first.body.user.id } } });

    // Used, and its person has left since: it won't sign in again.
    await request('POST', '/v1/parties/leave', { token: first.body.userToken, body: { code: party.code } });
    expect(await accept({ token, name: 'Guest' })).toMatchObject({ status: 409, body: { error: { code: 'link_used', field: 'token' } } });
  });

  it('refuses an expired invite, another kind of token, and garbage', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const party = await createParty(host.token);
    expect(await accept({ token: await inviteLink(uniqueEmail(), party.code, -60), name: 'Guest' })).toMatchObject({
      status: 400, body: { error: { code: 'link_expired', field: 'token' } },
    });
    const magicLink = await jwt().issueToken('EnterRequest', { email: uniqueEmail(), jti: crypto.randomUUID(), party: party.code }, { ttl: 60 });
    for (const token of [magicLink, 'garbage']) {
      expect(await accept({ token, name: 'Guest' })).toMatchObject({ status: 400, body: { error: { code: 'invalid_link', field: 'token' } } });
    }
    expect(await accept({ token: await inviteLink(uniqueEmail(), party.code), name: '' })).toMatchObject({
      status: 400, body: { error: { field: 'name' } },
    });
  });

  it('refuses a party that is gone, drawn, or full, without using the link', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const email = uniqueEmail('late');

    const deleted = await createParty(host.token);
    await request('POST', '/v1/parties/delete', { token: host.token, body: { code: deleted.code } });
    expect(await accept({ token: await inviteLink(email, deleted.code), name: 'Guest' })).toMatchObject({
      status: 404, body: { error: { code: 'not_found', field: 'party' } },
    });

    const drawn = await createParty(host.token);
    const guest = await signIn(uniqueEmail('guest'), 'Guest');
    await request('POST', '/v1/parties/join', { token: guest.token, body: { code: drawn.code, name: 'Guest' } });
    await request('POST', '/v1/parties/draw', { token: host.token, body: { code: drawn.code } });
    expect(await accept({ token: await inviteLink(email, drawn.code), name: 'Guest' })).toMatchObject({
      status: 409, body: { error: { code: 'conflict', field: 'party' } },
    });

    const full = await createParty(host.token);
    await runInDurableObject(env.PARTY.getByName(full.code), async (_i, state) => {
      for (let i = 1; i < MAX_PARTY_MEMBERS; i++) {
        state.storage.sql.exec('INSERT INTO memberships (member_id, name, joined_at) VALUES (?, ?, ?)', `stand-in-${i}`, `Stand-in ${i}`, Date.now());
      }
    });
    expect(await accept({ token: await inviteLink(email, full.code), name: 'Guest' })).toMatchObject({
      status: 409, body: { error: { code: 'conflict', field: 'party', message: `This party is full: it already has ${MAX_PARTY_MEMBERS} people.` } },
    });
    expect(await env.USER.getByName(email).get()).toBeNull();
  });
});

describe('POST /v1/auth/magic-link/again with an invite', () => {
  it('emails a magic link for the party to the invited address', async () => {
    const host = await signIn(uniqueEmail('host'), 'Host');
    const party = await createParty(host.token);
    const email = uniqueEmail('expired');
    const { sent, EMAIL } = mailer();
    const expired = await inviteLink(email, party.code, -3600);
    expect((await request('POST', '/v1/auth/magic-link/again', { body: { token: expired }, env: testEnv({ EMAIL }) })).status).toBe(202);
    expect(sent.map(m => m.to)).toEqual([email]);
    const fresh = await jwt().jwtVerify<EnterRequestToken>(tokenIn(sent[0].text), 'EnterRequest');
    expect(fresh).toMatchObject({ email, party: party.code });
    expect(fresh.typed).toBeUndefined();
  });
});

describe('UserDO.redeemedBy', () => {
  it('stores nothing for an address that never signed in', async () => {
    const email = uniqueEmail('never');
    expect(await env.USER.getByName(email).redeemedBy(crypto.randomUUID(), 'key')).toBeNull();
    expect(await runInDurableObject(env.USER.getByName(email), async (_i, state) =>
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'").toArray())).toEqual([]);
  });
});
