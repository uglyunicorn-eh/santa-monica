import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { app } from 'src/index';

import { EnterRequestToken, UserToken } from 'src/apollo/types';

import { gql, jwt, signIn } from './helpers';

const PARTY_FIELDS = 'id name code password isJoined isHost isProtected isClosed participantCount participants target { id name }';

describe('GraphQL API', () => {
  it('serves the app info', async () => {
    const res = await app.request('/', {}, env);
    expect(await res.json()).toMatchObject({ status: 'ok', name: 'santa-monica' });
    expect(res.headers.get('X-Powered-By')).toBe('Maple syrup and magic, eh!');
  });

  it('signs in with a magic-link token and rejects it as a session token', async () => {
    const enterRequestToken = await jwt().issueToken<EnterRequestToken>('EnterRequest', { email: 'New.User@Example.com' }, { ttl: 300 });

    const { data } = await gql(`mutation ($t: String!) { auth { enter(input: { enterRequestToken: $t }) { status userToken user { id name } } } }`, { t: enterRequestToken });
    expect(data.auth.enter.status).toBe('ok');
    const userToken = data.auth.enter.userToken;

    const me = await gql('{ user { id name } }', {}, userToken);
    expect(me.data.user.id).toBe(data.auth.enter.user.id);

    const asSession = await gql('{ user { id } }', {}, enterRequestToken);
    expect(asSession.data.user).toBeNull();

    // The email is normalised, so a second sign-in finds the same user.
    const again = await jwt().issueToken<EnterRequestToken>('EnterRequest', { email: 'new.user@example.com' }, { ttl: 300 });
    const second = await gql(`mutation ($t: String!) { auth { enter(input: { enterRequestToken: $t }) { user { id } } } }`, { t: again });
    expect(second.data.auth.enter.user.id).toBe(data.auth.enter.user.id);
  });

  it('rejects mutations without a session', async () => {
    const res = await gql('mutation { parties { createParty(input: { name: "x" }) { status } } }');
    expect(res.errors?.[0]?.message).toBe('UNAUTHENTICATED');
  });

  it('runs a whole party: create, join, list, close, see the target', async () => {
    const host = await signIn('gql-host@example.com', 'Host');
    const guest = await signIn('gql-guest@example.com', 'Guest');

    const created = await gql(`mutation { parties { createParty(input: { name: "Office", password: "Elf" }) { status node { ${PARTY_FIELDS} } } } }`, {}, host.token);
    const party = created.data.parties.createParty.node;
    expect(party).toMatchObject({ name: 'Office', isHost: true, password: 'Elf', participantCount: 1 });
    expect(party.code).toMatch(/^[QWERTYUIPASDFGHJKLZXCVBNMO]{5}$/);

    const anonymous = await gql(`query ($code: String!) { party(code: $code) { ${PARTY_FIELDS} } }`, { code: party.code.toLowerCase() });
    expect(anonymous.data.party).toMatchObject({ id: party.id, isJoined: false, isProtected: true, password: null, participantCount: null });

    const joined = await gql(`mutation ($p: ID!) { parties { joinParty(input: { party: $p, name: "Guesty", password: "elf" }) { status userErrors { fieldName messages } node { ${PARTY_FIELDS} } } } }`, { p: party.id }, guest.token);
    expect(joined.data.parties.joinParty).toMatchObject({ status: 'ok', node: { isJoined: true, participantCount: 2, participants: ['Host'] } });

    // User updates are delivered before the mutation returns, so the list is current right away.
    const listed = await gql(`{ parties { code } }`, {}, guest.token);
    expect(listed.data.parties).toEqual([{ code: party.code }]);

    const guestCantClose = await gql(`mutation ($p: ID!) { parties { closeParty(input: { party: $p }) { status userErrors { messages } } } }`, { p: party.id }, guest.token);
    expect(guestCantClose.data.parties.closeParty.status).toBe('error');

    const closed = await gql(`mutation ($p: ID!) { parties { closeParty(input: { party: $p }) { status node { ${PARTY_FIELDS} } } } }`, { p: party.id }, host.token);
    expect(closed.data.parties.closeParty.node).toMatchObject({ isClosed: true, target: { id: guest.nodeId, name: 'Guesty' } });

    const guestView = await gql(`query ($code: String!) { party(code: $code) { target { id name } } }`, { code: party.code }, guest.token);
    expect(guestView.data.party.target).toEqual({ id: host.nodeId, name: 'Host' });
  });

  it('rejects a node id that is not a party', async () => {
    const user = await signIn('gql-odd@example.com', 'Odd');
    const res = await gql(`mutation ($p: ID!) { parties { joinParty(input: { party: $p, name: "x" }) { status userErrors { fieldName } } } }`, { p: user.nodeId }, user.token);
    expect(res.data.parties.joinParty).toEqual({ status: 'error', userErrors: [{ fieldName: 'party' }] });
  });

  it('returns 400 for an invalid JSON body', async () => {
    const res = await app.request('/graph', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }, env);
    expect(res.status).toBe(400);
  });
});

describe('enterRequest', () => {
  const ENTER_REQUEST = `mutation ($email: String!, $party: String) { auth { enterRequest(input: { email: $email, party: $party }) { status userErrors { fieldName messages } } } }`;

  it('sends a magic link', async () => {
    const res = await gql(ENTER_REQUEST, { email: 'magic@example.com' });
    expect(res.data.auth.enterRequest).toEqual({ status: 'ok', userErrors: null });
  });

  it('rejects an unknown party code', async () => {
    const res = await gql(ENTER_REQUEST, { email: 'magic-party@example.com', party: 'QQQQQ' });
    expect(res.data.auth.enterRequest).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'party' }] });
  });

  it('rate-limits repeated requests for the same email', async () => {
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push((await gql(ENTER_REQUEST, { email: 'Spam.Target@example.com' })).data.auth.enterRequest.status);
    }
    expect(results.slice(0, 3)).toEqual(['ok', 'ok', 'ok']);
    expect(results.slice(3)).toEqual(['error', 'error']);
  });
});

describe('Admin import', () => {
  const snapshot = {
    users: [{ id: 'c'.repeat(24), email: 'imported@example.com', name: 'Imported', joined: 1, parties: [{ slug: 'TYUIO', name: 'Old party', createdAt: 1 }] }],
    parties: [{
      id: 'd'.repeat(24), slug: 'TYUIO', name: 'Old party', password: null, hostId: 'c'.repeat(24), isClosed: false, createdAt: 1,
      members: [{ id: 'c'.repeat(24), email: 'imported@example.com', name: 'Imported', targetId: null, targetName: null, joinedAt: 1 }],
    }],
  };

  it('is hidden without the secret', async () => {
    const res = await app.request('/admin/import', { method: 'POST', body: JSON.stringify(snapshot) }, env);
    expect(res.status).toBe(404);
  });

  it('imports users and parties and reports counts', async () => {
    const res = await app.request('/admin/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-secret': env.ADMIN_SECRET! },
      body: JSON.stringify(snapshot),
    }, env);
    expect(await res.json()).toEqual({ status: 'ok', imported: { users: 1, userParties: 1, parties: 1, memberships: 1 } });

    const token = await jwt().issueToken<UserToken>('UserToken', { sub: btoa(`User:${'c'.repeat(24)}`), email: 'imported@example.com' }, { ttl: 60 });
    const listed = await gql(`{ user { name } parties { code isHost isJoined } }`, {}, token);
    expect(listed.data).toEqual({ user: { name: 'Imported' }, parties: [{ code: 'TYUIO', isHost: true, isJoined: true }] });
  });
});
