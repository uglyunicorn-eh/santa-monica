import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import * as yup from 'yup';

import { ApolloContext, authenticate, makeContext, requireUser } from 'src/apollo/context';
import mutations from 'src/apollo/mutations';
import resolvers from 'src/apollo/resolvers';
import { decodeCursor, encodeCursor, partyViewToNode } from 'src/apollo/resolvers/party';
import { EnterRequestToken, UserToken } from 'src/apollo/types';
import { MailMessage } from 'src/mail';
import resolvable from 'src/utils/graphql/resolvable';
import { createJwtHelpers } from 'src/utils/jwt';
import { nodeIdToStr } from 'src/utils/strings/nodeId';

import { domain } from 'src/config.json';

let counter = 0;
const uniqueEmail = (label = 'user') => `${label}-${Date.now().toString(36)}-${++counter}@example.com`;
const jwt = createJwtHelpers({ privateKey: env.JWT_PRIVATE_KEY, issuer: domain });

type TestContext = ApolloContext & { sent: { to: string; message: MailMessage }[] };

function context(overrides: Partial<ApolloContext> = {}): TestContext {
  const sent: TestContext['sent'] = [];
  return {
    env,
    clientIp: `192.0.2.${++counter % 250}`,
    retrieveUser: async () => null,
    sendMail: async (to, message) => { sent.push({ to, message }); },
    ...jwt,
    sent,
    ...overrides,
  };
}

async function signedIn(name = 'Person', overrides: Partial<ApolloContext> = {}) {
  const email = uniqueEmail();
  const user = await env.USER.getByName(email).ensure(email);
  await env.USER.getByName(email).apply([{ type: 'setName', name }]);
  return context({
    userId: user.id,
    userEmail: email,
    retrieveUser: async () => await env.USER.getByName(email).get(),
    ...overrides,
  });
}

const { auth, parties, profile } = mutations.Mutation;
const { party, parties: listParties, partyHistory, user, app } = resolvers.Query;

/** A request context built the way the Worker builds it, from a session token. */
const requestContext = async (token: string) =>
  await makeContext({ env, req: { header: (name: string) => (name === 'authorization' ? `Bearer ${token}` : undefined) } } as any);

const sessionToken = (id: string, email: string, ver?: number) =>
  jwt.issueToken<UserToken>('UserToken', { sub: nodeIdToStr({ kind: 'User', id }), email, ...(ver === undefined ? {} : { ver }) }, { ttl: 60 });

const updateName = async (ctx: ApolloContext, name: string) =>
  await profile().updateName({ input: { name } }, ctx) as any;

const createParty = async (ctx: ApolloContext, name = 'Party', password?: string) =>
  await parties(null, {}, ctx).createParty({ input: { name, password } }, ctx) as any;

describe('auth mutations', () => {
  it('sends a magic link for a valid email', async () => {
    const ctx = context();
    const email = uniqueEmail();
    expect(await auth().enterRequest({ input: { email: email.toUpperCase(), party: undefined as any } }, ctx)).toEqual({ status: 'ok', userErrors: null });
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].to).toBe(email);
    expect(ctx.sent[0].message.text).toMatch(/https:\/\/gnomik\.me\/enter\//);
  });

  it('puts a valid party code into the magic link', async () => {
    const host = await signedIn('Host');
    const created = await createParty(host);
    const ctx = context();
    await auth().enterRequest({ input: { email: uniqueEmail(), party: created.node.code } }, ctx);
    const token = /enter\/(\S+)/.exec(ctx.sent[0].message.text)![1].replace(/[^\w.-].*$/, '');
    expect(await jwt.jwtVerify(token, 'EnterRequest')).toMatchObject({ party: created.node.code });
  });

  it('rejects an unknown party code', async () => {
    const ctx = context();
    expect(await auth().enterRequest({ input: { email: uniqueEmail(), party: 'QQQQQ' } }, ctx)).toMatchObject({
      status: 'error', userErrors: [{ fieldName: 'party', messages: ['Invalid party code.'] }],
    });
    expect(ctx.sent).toHaveLength(0);
  });

  it('stops when either rate limit is hit', async () => {
    const denied = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    const allowed = { limit: async () => ({ success: true }) } as unknown as RateLimit;
    for (const limits of [{ ENTER_RATE_LIMIT_IP: denied }, { ENTER_RATE_LIMIT_EMAIL: denied }]) {
      const ctx = context({ env: { ...env, ENTER_RATE_LIMIT_IP: allowed, ENTER_RATE_LIMIT_EMAIL: allowed, ...limits } });
      expect(await auth().enterRequest({ input: { email: uniqueEmail(), party: undefined as any } }, ctx)).toMatchObject({
        status: 'error', userErrors: [{ fieldName: 'email' }],
      });
      expect(ctx.sent).toHaveLength(0);
    }
  });

  it('reports a failed send', async () => {
    const ctx = context({ sendMail: async () => { throw new Error('down'); } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await auth().enterRequest({ input: { email: uniqueEmail(), party: undefined as any } }, ctx)).toMatchObject({
      status: 'error', userErrors: [{ fieldName: 'email' }],
    });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('signs in with a magic-link token and rejects anything else', async () => {
    const email = uniqueEmail();
    const token = await jwt.issueToken<EnterRequestToken>('EnterRequest', { email: email.toUpperCase(), jti: crypto.randomUUID() }, { ttl: 60 });
    const entered = await auth().enter({ input: { enterRequestToken: token } }, context()) as any;
    expect(entered).toMatchObject({ status: 'ok', user: { name: '', email } });
    expect(await jwt.jwtVerify<UserToken>(entered.userToken, 'UserToken')).toMatchObject({ sub: entered.user.id, email, ver: 0 });

    expect(await auth().enter({ input: { enterRequestToken: entered.userToken } }, context())).toMatchObject({
      status: 'error', userErrors: [{ fieldName: 'enterRequestToken', messages: ['Invalid request token.'] }],
    });
  });

  it('puts a fresh id in every magic link', async () => {
    const ctx = context();
    const email = uniqueEmail();
    await auth().enterRequest({ input: { email, party: undefined as any } }, ctx);
    await auth().enterRequest({ input: { email, party: undefined as any } }, ctx);
    const ids = await Promise.all(ctx.sent.map(async ({ message }) => {
      const token = /enter\/([\w-]+\.[\w-]+\.[\w-]+)/.exec(message.text)![1];
      return (await jwt.jwtVerify<EnterRequestToken>(token, 'EnterRequest')).jti;
    }));
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it('lets a magic link be used only once', async () => {
    const token = await jwt.issueToken<EnterRequestToken>('EnterRequest', { email: uniqueEmail(), jti: crypto.randomUUID() }, { ttl: 60 });
    expect(await auth().enter({ input: { enterRequestToken: token } }, context())).toMatchObject({ status: 'ok' });
    expect(await auth().enter({ input: { enterRequestToken: token } }, context())).toEqual({
      status: 'error', userErrors: [{ fieldName: 'enterRequestToken', messages: ['This magic link has already been used. Please request a new one.'] }],
    });
  });

  it('rejects magic-link tokens without an id or an expiry', async () => {
    const invalid = { status: 'error', userErrors: [{ fieldName: 'enterRequestToken', messages: ['Invalid request token.'] }] };
    const withoutId = await jwt.issueToken<EnterRequestToken>('EnterRequest', { email: uniqueEmail() }, { ttl: 60 });
    const withoutExpiry = await jwt.issueToken<EnterRequestToken>('EnterRequest', { email: uniqueEmail(), jti: crypto.randomUUID() });
    expect(await auth().enter({ input: { enterRequestToken: withoutId } }, context())).toMatchObject(invalid);
    expect(await auth().enter({ input: { enterRequestToken: withoutExpiry } }, context())).toMatchObject(invalid);
  });
});

describe('party mutations', () => {
  it('creates a party for the signed-in user, with or without a secret phrase', async () => {
    const host = await signedIn('Host');
    expect(await createParty(host, 'Open')).toMatchObject({ status: 'ok', node: { isHost: true, isProtected: false } });
    expect(await createParty(host, 'Closed', 'pw')).toMatchObject({ status: 'ok', node: { isProtected: true, password: 'pw' } });
  });

  it('needs a user to create a party', async () => {
    // A valid session for an email that has no profile.
    const ctx = context({ userId: 'ghost', userEmail: uniqueEmail() });
    expect(await createParty(ctx)).toMatchObject({ status: 'error', userErrors: [{ fieldName: null }] });
  });

  it('lets one person host up to three open parties', async () => {
    const host = await signedIn('Host');
    const created = [];
    for (let i = 0; i < 3; i++) {
      created.push(await createParty(host, `Party ${i}`));
    }
    expect(created.map(c => c.status)).toEqual(['ok', 'ok', 'ok']);

    expect(await createParty(host, 'One too many')).toEqual({
      status: 'error',
      userErrors: [{ fieldName: null, messages: ['You can host up to 3 open parties at a time. Close or cancel one of them to start a new one.'] }],
    });

    // Closing one (it needs a second participant) frees a slot.
    const guest = await signedIn('Guest');
    await parties(null, {}, guest).joinParty({ input: { party: created[0].node.id, name: 'Guest' } }, guest);
    expect((await parties(null, {}, host).closeParty({ input: { party: created[0].node.id } }, host) as any).status).toBe('ok');
    expect((await createParty(host, 'Replacement')).status).toBe('ok');
  });

  it('does not count parties joined as a guest towards the limit', async () => {
    const guest = await signedIn('Guest');
    for (let i = 0; i < 3; i++) {
      const other = await signedIn('Other');
      const { node } = await createParty(other, `Other ${i}`);
      expect((await parties(null, {}, guest).joinParty({ input: { party: node.id, name: 'Guest' } }, guest) as any).status).toBe('ok');
    }
    expect((await createParty(guest, 'Mine')).status).toBe('ok');
  });

  describe('cancelling a party', () => {
    const cancel = async (ctx: ApolloContext, id: string) =>
      await parties(null, {}, ctx).cancelParty({ input: { party: id } }, ctx) as any;
    const join = async (ctx: ApolloContext, id: string) =>
      await parties(null, {}, ctx).joinParty({ input: { party: id, name: 'Guest' } }, ctx) as any;

    it('deletes a party only the host is in, removes it from their list and frees the slot', async () => {
      const host = await signedIn('Host');
      const created = [];
      for (let i = 0; i < 3; i++) {
        created.push((await createParty(host, `Party ${i}`)).node);
      }
      expect((await createParty(host, 'Fourth')).status).toBe('error');

      expect(await cancel(host, created[0].id)).toEqual({ status: 'ok', userErrors: null });
      expect(await party(null, { code: created[0].code }, host)).toBeNull();
      expect((await listParties(null, { first: 10 }, host))!.map((p: any) => p.code)).not.toContain(created[0].code);
      expect((await createParty(host, 'Fourth')).status).toBe('ok');

      // Cancelling again: the party is gone.
      expect(await cancel(host, created[0].id)).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'party', messages: ['Party does not exist.'] }] });
    });

    it('is only for the host, before anyone joins and before the draw', async () => {
      const host = await signedIn('Host');
      const guest = await signedIn('Guest');
      const { node } = await createParty(host, 'Popular');

      expect(await cancel(guest, node.id)).toMatchObject({ status: 'error', userErrors: [{ messages: ['You must be the host to cancel the party.'] }] });

      await join(guest, node.id);
      expect(await cancel(host, node.id)).toMatchObject({ status: 'error', userErrors: [{ messages: ['Someone has already joined this party, so it can no longer be cancelled.'] }] });

      await parties(null, {}, host).closeParty({ input: { party: node.id } }, host);
      expect(await cancel(host, node.id)).toMatchObject({ status: 'error', userErrors: [{ messages: ['Party is already closed.'] }] });
    });

    it('does not let the host leave their own party (they cancel it instead)', async () => {
      const host = await signedIn('Host');
      const { node } = await createParty(host, 'Mine');
      expect(await parties(null, {}, host).leaveParty({ input: { party: node.id } }, host)).toMatchObject({
        status: 'error',
        userErrors: [{ fieldName: 'party', messages: ["As the host, you can't leave your own party. Cancel it instead, or close it once others have joined."] }],
      });
      expect((await listParties(null, { first: 10 }, host))!.map((p: any) => p.code)).toEqual([node.code]);
    });

    it('works for a host who left their party before hosts were kept from leaving', async () => {
      const host = await signedIn('Host');
      const { node } = await createParty(host, 'Abandoned');
      await runInDurableObject(env.PARTY.getByName(node.code), async (_i, state) => {
        state.storage.sql.exec('DELETE FROM memberships');
      });
      expect((await cancel(host, node.id)).status).toBe('ok');
      expect(await party(null, { code: node.code }, host)).toBeNull();
    });

    it('never hands out a cancelled code again', async () => {
      const host = await signedIn('Host');
      const { node } = await createParty(host, 'Once');
      await cancel(host, node.id);
      const again = await env.PARTY.getByName(node.code).create({
        id: 'x', slug: node.code, name: 'Twice', password: null, host: { id: 'h', email: null, name: 'H' },
      });
      expect(again).toEqual({ ok: false, conflict: true });
    });

    it('cancels a party created before tombstones existed', async () => {
      const host = await signedIn('Host');
      const { node } = await createParty(host, 'Old');
      await runInDurableObject(env.PARTY.getByName(node.code), async (_i, state) => {
        state.storage.sql.exec('DROP TABLE cancelled');
      });
      expect((await cancel(host, node.id)).status).toBe('ok');
    });

    it('rejects ids that are not parties', async () => {
      const host = await signedIn('Host');
      expect(await cancel(host, nodeIdToStr({ kind: 'User', id: 'x' }))).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'party' }] });
      expect(await cancel(host, '')).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'party' }] });
    });
  });

  it('retries on a code collision, and gives up after ten', async () => {
    const host = await signedIn('Host');
    let calls = 0;
    const collideOnce = {
      ...env,
      PARTY: { getByName: (slug: string) => (++calls === 1 ? { create: async () => ({ ok: false, conflict: true }) } : env.PARTY.getByName(slug)) },
    } as typeof env;
    expect(await createParty({ ...host, env: collideOnce })).toMatchObject({ status: 'ok' });
    expect(calls).toBe(2);

    const alwaysCollide = { ...env, PARTY: { getByName: () => ({ create: async () => ({ ok: false, conflict: true }) }) } } as unknown as typeof env;
    await expect(createParty({ ...host, env: alwaysCollide })).rejects.toThrow('Unable to generate a unique party code.');
  });

  it('joins, leaves and closes through party node ids', async () => {
    const host = await signedIn('Host');
    const guest = await signedIn('Guest');
    const { node } = await createParty(host, 'P', 'pw');

    expect(await parties(null, {}, guest).joinParty({ input: { party: node.id, name: 'G', password: undefined } }, guest)).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'password' }] });
    expect(await parties(null, {}, guest).joinParty({ input: { party: node.id, name: 'G', password: 'PW' } }, guest)).toMatchObject({ status: 'ok', node: { isJoined: true } });
    expect(await parties(null, {}, guest).leaveParty({ input: { party: node.id } }, guest)).toMatchObject({ status: 'ok', node: { isJoined: false } });
    await parties(null, {}, guest).joinParty({ input: { party: node.id, name: 'G', password: 'pw' } }, guest);
    expect(await parties(null, {}, host).closeParty({ input: { party: node.id } }, host)).toMatchObject({ status: 'ok', node: { isClosed: true, target: { name: 'G' } } });
  });

  it('needs a session for every party mutation', async () => {
    expect(() => parties(null, {}, context())).toThrow('UNAUTHENTICATED');
    expect(() => parties(null, {}, context({ userId: 'a'.repeat(24) }))).toThrow('UNAUTHENTICATED');
    expect(() => requireUser({ ...context(), userId: 'a'.repeat(24), userEmail: 'a@example.com' })).not.toThrow();
  });

  it('joins with the session and the name from the form, without reading the profile', async () => {
    const host = await signedIn('Host');
    const { node } = await createParty(host);
    const guest = await signedIn('Old name', { retrieveUser: async () => { throw new Error('profile should not be read'); } });
    expect(await parties(null, {}, guest).joinParty({ input: { party: node.id, name: 'Form name' } }, guest)).toMatchObject({ status: 'ok', node: { isJoined: true, participants: ['Host'] } });
    // Joining doesn't overwrite a profile name...
    expect((await env.USER.getByName(guest.userEmail!).get())!.name).toBe('Old name');

    // ...but fills in an empty one.
    const newcomer = await signedIn('');
    await parties(null, {}, newcomer).joinParty({ input: { party: node.id, name: 'First join' } }, newcomer);
    expect((await env.USER.getByName(newcomer.userEmail!).get())!.name).toBe('First join');
  });

  it('rejects ids that are not parties', async () => {
    const ctx = await signedIn();
    const unknown = { status: 'error', userErrors: [{ fieldName: 'party', messages: ['Unknown input type. Must be Party.'] }] };
    for (const id of [nodeIdToStr({ kind: 'User', id: 'x' }), nodeIdToStr({ kind: 'Party', id: 'lower' }), '%%%']) {
      expect(await parties(null, {}, ctx).joinParty({ input: { party: id, name: 'x' } }, ctx)).toMatchObject(unknown);
      expect(await parties(null, {}, ctx).leaveParty({ input: { party: id } }, ctx)).toMatchObject(unknown);
      expect(await parties(null, {}, ctx).closeParty({ input: { party: id } }, ctx)).toMatchObject(unknown);
    }
  });

  it('turns validation failures into user errors', async () => {
    const ctx = await signedIn();
    expect(await createParty(ctx, '')).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'name' }] });
  });
});

describe('queries', () => {
  it('returns the app info', async () => {
    expect(await app()).toEqual({ author: expect.any(String), name: 'santa-monica', version: expect.any(String) });
  });

  it('looks up parties by code, case-insensitively, and ignores malformed codes', async () => {
    const host = await signedIn('Host');
    const { node } = await createParty(host, 'Mine');
    expect(await party(null, { code: node.code.toLowerCase() }, host)).toMatchObject({ code: node.code, isHost: true });
    expect(await party(null, { code: 'nope!' }, host)).toBeNull();
  });

  it('lists my parties, clamping the page size', async () => {
    const host = await signedIn('Host');
    await createParty(host, 'A');
    await createParty(host, 'B');
    expect((await listParties(null, { first: 25 }, host))!.map((p: any) => p.name)).toEqual(['B', 'A']);
    expect(await listParties(null, { first: 1000 }, host)).toHaveLength(2);
    expect(await listParties(null, { first: -5 }, host)).toEqual([]);
    expect(await listParties(null, { first: 25 }, context())).toBeNull();
  });

  it('returns the signed-in user, or null', async () => {
    const ctx = await signedIn('Me');
    expect(await user(null, {}, ctx)).toMatchObject({ id: nodeIdToStr({ kind: 'User', id: ctx.userId! }), name: 'Me', email: ctx.userEmail });
    expect(await user(null, {}, context({ retrieveUser: async () => null }))).toBeNull();
  });

  it('maps a party view to a node, with and without a target', () => {
    expect(partyViewToNode(null)).toBeNull();
    const view = {
      id: 'x', slug: 'QWERT', name: 'P', password: null, isProtected: false, isHost: false, isJoined: true,
      isClosed: true, createdAt: Date.UTC(2026, 11, 1, 18, 30), closedAt: Date.UTC(2026, 11, 20, 9, 0, 5, 250),
      participantCount: 2, participants: ['A'], target: { id: 'a'.repeat(24), name: 'A' },
    };
    expect(partyViewToNode(view)).toMatchObject({
      id: nodeIdToStr({ kind: 'Party', id: 'QWERT' }), target: { id: nodeIdToStr({ kind: 'User', id: 'a'.repeat(24) }), name: 'A' },
      createdAt: '2026-12-01T18:30:00.000Z', rolledAt: '2026-12-20T09:00:05.250Z',
    });
    expect(partyViewToNode({ ...view, target: null, closedAt: null })).toMatchObject({ target: null, rolledAt: null });
  });
});

describe('party times', () => {
  it('gives every party its start time, and its roll time once drawn, from the party and from the list alike', async () => {
    const host = await signedIn('Host');
    const guest = await signedIn('Guest');
    const { node } = await createParty(host, 'Timed');
    expect(node.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(node.rolledAt).toBeNull();
    await parties(null, {}, guest).joinParty({ input: { party: node.id, name: 'G' } }, guest);
    expect((await partyHistory(null, { first: 10 }, guest) as any).items[0]).toMatchObject({ createdAt: node.createdAt, rolledAt: null });

    const closed = await parties(null, {}, host).closeParty({ input: { party: node.id } }, host) as any;
    expect(closed.node.rolledAt).toMatch(/Z$/);
    expect(Date.parse(closed.node.rolledAt)).toBeGreaterThanOrEqual(Date.parse(node.createdAt));
    expect(await party(null, { code: node.code }, { ...guest, partyNodes: undefined })).toMatchObject({ createdAt: node.createdAt, rolledAt: closed.node.rolledAt });
    expect((await partyHistory(null, { first: 10 }, host) as any).items[0]).toMatchObject({ createdAt: node.createdAt, rolledAt: closed.node.rolledAt });
  });

  it('refreshes the roll time along with the rest of a stale summary', async () => {
    const host = await signedIn('Host');
    const guest = await signedIn('Guest');
    const { node } = await createParty(host, 'Stale');
    await parties(null, {}, guest).joinParty({ input: { party: node.id, name: 'G' } }, guest);
    const closed = await parties(null, {}, host).closeParty({ input: { party: node.id } }, host) as any;
    await runInDurableObject(env.USER.getByName(host.userEmail!), async (_i, state) => {
      state.storage.sql.exec('UPDATE parties SET is_host = NULL, closed_at = NULL');
    });
    expect((await partyHistory(null, { first: 10 }, host) as any).items[0]).toMatchObject({ rolledAt: closed.node.rolledAt });
    const [stored] = await env.USER.getByName(host.userEmail!).listParties(10);
    expect(stored).toMatchObject({ isHost: true, closedAt: Date.parse(closed.node.rolledAt) });
  });
});

describe('party history', () => {
  const addParties = async (email: string, parties: [string, number][]) =>
    await env.USER.getByName(email).apply(parties.map(([slug, createdAt]) => ({
      type: 'addParty' as const, party: { slug, name: slug, createdAt, isHost: false, isProtected: false, isClosed: false, closedAt: null },
    })));

  it('pages through my parties, newest first, without skipping or repeating parties created together', async () => {
    const me = await signedIn('Me');
    await addParties(me.userEmail!, [['QQQBA', 1], ['QQQBB', 2], ['QQQBC', 2], ['QQQBD', 2], ['QQQBE', 3]]);

    const first = await partyHistory(null, { first: 2 }, me) as any;
    expect(first.items.map((p: any) => p.code)).toEqual(['QQQBE', 'QQQBD']);
    expect(first.hasMore).toBe(true);
    const second = await partyHistory(null, { first: 2, after: first.endCursor }, me) as any;
    expect(second.items.map((p: any) => p.code)).toEqual(['QQQBC', 'QQQBB']);
    expect(second.hasMore).toBe(true);
    const third = await partyHistory(null, { first: 2, after: second.endCursor }, me) as any;
    expect(third).toMatchObject({ items: [{ code: 'QQQBA', isJoined: true }], hasMore: false });
    expect(await partyHistory(null, { first: 2, after: third.endCursor }, me)).toEqual({ items: [], hasMore: false, endCursor: null });
  });

  it('fits exactly: no more after a full last page', async () => {
    const me = await signedIn('Me');
    await addParties(me.userEmail!, [['QQQCA', 1], ['QQQCB', 2]]);
    expect(await partyHistory(null, { first: 2, after: null }, me)).toMatchObject({ hasMore: false });
    expect(await partyHistory(null, { first: 1000 }, me)).toMatchObject({ hasMore: false });
    // At least one per page, so "more" always comes with a cursor.
    for (const first of [0, -1]) {
      expect(await partyHistory(null, { first }, me)).toMatchObject({ items: [{ code: 'QQQCB' }], hasMore: true, endCursor: expect.any(String) });
    }
  });

  it('is null without a session, and rejects a malformed cursor', async () => {
    expect(await partyHistory(null, { first: 10 }, context())).toBeNull();
    const me = await signedIn('Me');
    for (const cursor of ['%%%', btoa('nope'), btoa('12:lower')]) {
      await expect(partyHistory(null, { first: 10, after: cursor }, me)).rejects.toThrow('Invalid cursor.');
    }
  });

  it('round-trips cursors', () => {
    expect(decodeCursor(encodeCursor({ createdAt: 1700000000000, slug: 'QWERT' }))).toEqual({ createdAt: 1700000000000, slug: 'QWERT' });
  });

  it('keeps going past a party that no longer exists', async () => {
    const me = await signedIn('Me');
    await addParties(me.userEmail!, [['QQQDA', 1], ['QQQDB', 2]]);
    await runInDurableObject(env.USER.getByName(me.userEmail!), async (_i, state) => {
      state.storage.sql.exec('UPDATE parties SET is_host = NULL');
    });
    const page = await partyHistory(null, { first: 1 }, me) as any;
    expect(page).toMatchObject({ items: [], hasMore: true });
    expect(await partyHistory(null, { first: 1, after: page.endCursor }, me)).toMatchObject({ items: [], hasMore: false, endCursor: expect.any(String) });
  });
});

describe('profile mutations', () => {
  it('needs a session, checked before the input', async () => {
    await expect(updateName(context(), 'Nope')).rejects.toThrow('UNAUTHENTICATED');
    await expect(updateName(context(), '')).rejects.toThrow('UNAUTHENTICATED');
  });

  it('sets the profile name and returns the user', async () => {
    const me = await signedIn('Old');
    expect(await updateName(me, '  New   name ')).toEqual({
      status: 'ok', userErrors: null,
      user: { id: nodeIdToStr({ kind: 'User', id: me.userId! }), name: 'New name', email: me.userEmail, joined: expect.any(Date) },
    });
    expect((await env.USER.getByName(me.userEmail!).get())!.name).toBe('New name');
  });

  it('validates the name', async () => {
    const me = await signedIn('Old');
    expect(await updateName(me, '   ')).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'name' }] });
    expect(await updateName(me, 'x'.repeat(101))).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'name' }] });
  });

  it('doesn\'t rename me in parties I already joined, open or drawn', async () => {
    const host = await signedIn('Host');
    const guest = await signedIn('Guest');
    const open = (await createParty(host, 'Open')).node;
    const drawn = (await createParty(host, 'Drawn')).node;
    for (const { id } of [open, drawn]) {
      await parties(null, {}, guest).joinParty({ input: { party: id, name: 'Joined as' } }, guest);
    }
    await parties(null, {}, host).closeParty({ input: { party: drawn.id } }, host);

    await updateName(guest, 'Renamed');
    expect((await party(null, { code: open.code }, host) as any).participants).toEqual(['Host', 'Joined as']);
    expect(await party(null, { code: drawn.code }, host)).toMatchObject({ participants: ['Host', 'Joined as'], target: { name: 'Joined as' } });
  });

  it('refuses a revoked session', async () => {
    const email = uniqueEmail();
    const stored = await env.USER.getByName(email).ensure(email);
    const ctx = await requestContext(await sessionToken(stored.id, email, 0));
    await env.USER.getByName(email).tombstone();
    expect(await updateName(ctx, 'Back')).toEqual({
      status: 'error', userErrors: [{ fieldName: null, messages: ['Your session has expired. Please sign in again.'] }],
    });
  });
});

describe('token revocation', () => {
  const newUser = async () => {
    const email = uniqueEmail();
    const stored = await env.USER.getByName(email).ensure(email);
    return { email, id: stored.id };
  };

  it('accepts tokens with the current version, and tokens issued before versions existed', async () => {
    const { email, id } = await newUser();
    for (const token of [await sessionToken(id, email, 0), await sessionToken(id, email)]) {
      const ctx = await requestContext(token);
      expect(await ctx.retrieveUser()).toMatchObject({ id, email });
      expect(await updateName(ctx, 'Fine')).toMatchObject({ status: 'ok' });
      expect(await createParty(ctx)).toMatchObject({ status: 'ok' });
    }
  });

  it('refuses a deleted account: no user, no new parties, no joining', async () => {
    const host = await signedIn('Host');
    const { node } = await createParty(host);
    const { email, id } = await newUser();
    const ctx = await requestContext(await sessionToken(id, email, 0));
    await env.USER.getByName(email).tombstone();

    expect(await user(null, {}, ctx)).toBeNull();
    expect(await createParty(ctx)).toMatchObject({ status: 'error', userErrors: [{ fieldName: null }] });
    expect(await parties(null, {}, ctx).joinParty({ input: { party: node.id, name: 'Ghost' } }, ctx)).toEqual({
      status: 'error', userErrors: [{ fieldName: null, messages: ['You must be logged in before joining the party.'] }], node: undefined,
    });
    expect((await party(null, { code: node.code }, host) as any).participantCount).toBe(1);
  });

  it('refuses old tokens once the email signs up again, including tokens without a version', async () => {
    const { email, id } = await newUser();
    const tokens = [await sessionToken(id, email, 0), await sessionToken(id, email)];
    await env.USER.getByName(email).tombstone();
    const fresh = await env.USER.getByName(email).ensure(email);

    for (const token of tokens) {
      expect(await (await requestContext(token)).retrieveUser()).toBeNull();
    }
    // Right id but an old version: still refused.
    expect(await (await requestContext(await sessionToken(fresh.id, email, 0))).retrieveUser()).toBeNull();
    expect(await (await requestContext(await sessionToken(fresh.id, email, 1))).retrieveUser()).toMatchObject({ id: fresh.id });
  });
});

describe('request auth', () => {
  it('accepts a valid session token', async () => {
    const email = uniqueEmail();
    const stored = await env.USER.getByName(email).ensure(email);
    const token = await jwt.issueToken<UserToken>('UserToken', { sub: nodeIdToStr({ kind: 'User', id: stored.id }), email }, { ttl: 60 });
    expect(await authenticate(token, jwt.jwtVerify)).toStrictEqual({ userId: stored.id, userEmail: email });
    const versioned = await jwt.issueToken<UserToken>('UserToken', { sub: nodeIdToStr({ kind: 'User', id: stored.id }), email, ver: 3 }, { ttl: 60 });
    expect(await authenticate(versioned, jwt.jwtVerify)).toStrictEqual({ userId: stored.id, userEmail: email, tokenVersion: 3 });
  });

  it('treats missing and invalid tokens as anonymous', async () => {
    const email = uniqueEmail();
    const tokens = [
      undefined,
      'garbage',
      await jwt.issueToken<UserToken>('UserToken', { sub: nodeIdToStr({ kind: 'Party', id: 'QWERT' }), email }, { ttl: 60 }),
      await jwt.issueToken('UserToken', { sub: nodeIdToStr({ kind: 'User', id: 'a'.repeat(24) }) }, { ttl: 60 }),
      await jwt.issueToken<EnterRequestToken>('EnterRequest', { email }, { ttl: 60 }),
    ];
    for (const token of tokens) {
      expect(await authenticate(token, jwt.jwtVerify)).toEqual({});
    }
  });
});

describe('resolvable', () => {
  const schema = yup.object({ name: yup.string().trim().required() });
  const handler = resolvable(schema, 'test')(async (input: { name: string }) => ({ node: { id: input.name } }));

  it('passes cast input to the handler', async () => {
    expect(await handler({ input: { name: '  x  ' } }, context())).toEqual({ status: 'ok', userErrors: null, node: { id: 'x' } });
  });

  it('returns validation errors as user errors', async () => {
    expect(await handler({ input: { name: '' } }, context())).toEqual({ status: 'error', userErrors: [{ fieldName: 'name', messages: ['name is a required field'] }] });
  });
});

describe('request context', () => {
  const honoContext = (headers: Record<string, string>) => ({
    env,
    req: { header: (name: string) => headers[name] },
  }) as any;

  it('reads the client IP, and treats an invalid bearer token as anonymous', async () => {
    const ctx = await makeContext(honoContext({ 'cf-connecting-ip': '203.0.113.1', authorization: 'Bearer abc' }));
    expect(ctx).toMatchObject({ clientIp: '203.0.113.1', userId: undefined, userEmail: undefined });
    expect(await ctx.retrieveUser()).toBeNull();
  });

  it('verifies the session once, when the request comes in', async () => {
    const email = uniqueEmail();
    const stored = await env.USER.getByName(email).ensure(email);
    const token = await jwt.issueToken<UserToken>('UserToken', { sub: nodeIdToStr({ kind: 'User', id: stored.id }), email }, { ttl: 60 });
    const ctx = await makeContext(honoContext({ authorization: `Bearer ${token}` }));
    expect(ctx).toMatchObject({ userId: stored.id, userEmail: email });
    expect(await ctx.retrieveUser()).toMatchObject({ id: stored.id, email });
  });

  it('copes with missing headers', async () => {
    expect(await makeContext(honoContext({}))).toMatchObject({ clientIp: 'unknown', userId: undefined });
  });

  it('sends mail through the EMAIL binding', async () => {
    const send = vi.fn(async () => ({ messageId: 'm' }));
    const ctx = await makeContext({ env: { ...env, EMAIL: { send } }, req: { header: () => undefined } } as any);
    await ctx.sendMail('to@example.com', { subject: 's', html: 'h', text: 't' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'to@example.com', subject: 's', html: 'h', text: 't' }));
  });
});
