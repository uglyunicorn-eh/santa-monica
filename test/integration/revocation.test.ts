import { describe, expect, it } from 'vitest';

import { routeList } from 'src/api';

import {
  CallOptions, Person, apiError, call, changeEmail, createParty, deleteAccount, drawParty, joinParty, signIn,
  uniqueEmail, viewParty,
} from './support';

type Fixture = { host: Person; party: { code: string }; drawn: { code: string }; open: { code: string } };

/**
 * Every route the API serves, and how a revoked session token is treated there. Signed-in routes must answer 401;
 * the others say why they don't take a session. Adding a route without a row here fails the registry test below.
 */
const ROUTES: Record<string, { revoked: 'unauthenticated' | 'anonymous' | 'no session'; call?: (f: Fixture, token: string) => Promise<{ status: number; body: any }> }> = {
  'POST /auth/magic-link': { revoked: 'no session' },
  'POST /auth/session': { revoked: 'no session' },
  'POST /me/deletion/check': { revoked: 'no session' },
  'GET /parties/live': { revoked: 'no session' },
  'POST /me/deletion/confirm': { revoked: 'no session' },
  'POST /me/email-change/confirm': { revoked: 'no session' },
  'POST /me/email-change/cancel': { revoked: 'no session' },
  'GET /me': { revoked: 'unauthenticated', call: (f, token) => call('GET', '/v1/me', { token }) },
  'PATCH /me': { revoked: 'unauthenticated', call: (f, token) => call('PATCH', '/v1/me', { token, body: { name: 'Ghost' } }) },
  'GET /me/parties': { revoked: 'unauthenticated', call: (f, token) => call('GET', '/v1/me/parties', { token }) },
  'POST /me/sign-out': { revoked: 'unauthenticated', call: (f, token) => call('POST', '/v1/me/sign-out', { token }) },
  'POST /me/deletion': { revoked: 'unauthenticated', call: (f, token) => call('POST', '/v1/me/deletion', { token }) },
  'POST /me/email-change': { revoked: 'unauthenticated', call: (f, token) => call('POST', '/v1/me/email-change', { token, body: { email: uniqueEmail('ghost') } }) },
  'GET /parties': { revoked: 'anonymous', call: (f, token) => viewParty(f.drawn.code, { token }) },
  'POST /parties': { revoked: 'unauthenticated', call: (f, token) => call('POST', '/v1/parties', { token, body: { name: 'Ghost party' } }) },
  'POST /parties/join': { revoked: 'unauthenticated', call: (f, token) => joinParty({ token }, f.open, 'Ghost') },
  'POST /parties/leave': { revoked: 'unauthenticated', call: (f, token) => call('POST', '/v1/parties/leave', { body: { code: f.party.code }, token }) },
  'POST /parties/draw': { revoked: 'unauthenticated', call: (f, token) => call('POST', '/v1/parties/draw', { body: { code: f.party.code }, token }) },
  'POST /parties/delete': { revoked: 'unauthenticated', call: (f, token) => call('POST', '/v1/parties/delete', { body: { code: f.party.code }, token }) },
  'POST /parties/restore': { revoked: 'unauthenticated', call: (f, token) => call('POST', '/v1/parties/restore', { body: { code: f.party.code }, token }) },
  'POST /live/ticket': { revoked: 'unauthenticated', call: (f, token) => call('POST', '/v1/live/ticket', { token }) },
};

/** Someone who hosts an open party with a guest, is a guest in another open party, and has a drawn party with a target. */
async function setUp() {
  const who = await signIn(uniqueEmail('me'));
  const host = await signIn(uniqueEmail('host'));
  const guest = await signIn(uniqueEmail('guest'));
  const party = await createParty(who, 'Mine');
  await joinParty(guest, party, 'Guest');
  const open = await createParty(host, 'Open');
  const drawn = await createParty(host, 'Drawn');
  await joinParty(who, drawn, 'Me');
  await drawParty(host, drawn);
  expect((await viewParty(drawn.code, who)).body.target).not.toBeNull();
  return { who, fixture: { host, party, drawn, open } };
}

async function expectRevoked(fixture: Fixture, token: string) {
  for (const [route, { revoked, call: send }] of Object.entries(ROUTES)) {
    if (!send) {
      continue;
    }
    const res = await send(fixture, token);
    if (revoked === 'anonymous') {
      expect([route, res.status, res.body.isJoined, res.body.target, res.body.participants]).toEqual([route, 200, false, null, null]);
    } else {
      expect([route, res.status, res.body]).toEqual([route, 401, apiError('unauthenticated', expect.any(String))]);
    }
  }
}

describe('a revoked session token', () => {
  it('covers every route the API serves', () => {
    expect(new Set(routeList())).toEqual(new Set(Object.keys(ROUTES)));
  });

  it('works nowhere after an email change (same user id, newer token version)', async () => {
    const { who, fixture } = await setUp();
    const moved = await changeEmail(who, uniqueEmail('moved'));
    await expectRevoked(fixture, who.token);

    // Nothing changed through the old token: the party is still open with its guest, and the new token still works.
    expect((await viewParty(fixture.party.code, moved)).body).toMatchObject({ isClosed: false, deletedAt: null, participantCount: 2 });
    expect((await viewParty(fixture.drawn.code, moved)).body.target).not.toBeNull();
  });

  it('works nowhere after the account is deleted, not even on a newer account with the same email', async () => {
    const { who, fixture } = await setUp();
    await deleteAccount(who);
    const again = await signIn(who.email);
    await createParty(again, 'New life');
    await expectRevoked(fixture, who.token);
  });

  it('is told apart from a valid one only by the session check, not by the route', async () => {
    const { who, fixture } = await setUp();
    const options: CallOptions = { token: who.token };
    expect((await call('GET', '/v1/me', options)).status).toBe(200);
    expect((await viewParty(fixture.drawn.code, who)).body.isJoined).toBe(true);
  });
});
