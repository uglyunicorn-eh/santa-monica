import { env } from 'cloudflare:test';
import { GraphQLResolveInfo } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import * as yup from 'yup';

import { ApolloContext, makeContext } from 'src/apollo/context';
import { authMiddleware, guardMiddleware } from 'src/apollo/middleware';
import mutations from 'src/apollo/mutations';
import resolvers from 'src/apollo/resolvers';
import { partyViewToNode } from 'src/apollo/resolvers/party';
import { EnterRequestToken, UserToken } from 'src/apollo/types';
import { MailMessage } from 'src/mail';
import { getPathFromInfo } from 'src/utils/graphql';
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
    retrieveUser: async () => { throw new Error('Unable to retrieve user'); },
    sendMail: async (to, message) => { sent.push({ to, message }); },
    ...jwt,
    sent,
    ...overrides,
  };
}

async function signedIn(name = 'Person', overrides: Partial<ApolloContext> = {}) {
  const email = uniqueEmail();
  const user = await env.USER.getByName(email).ensure(email);
  await env.USER.getByName(email).setName(name);
  return context({
    userId: user.id,
    userEmail: email,
    retrieveUser: async () => await env.USER.getByName(email).get(),
    ...overrides,
  });
}

const { auth, parties } = mutations.Mutation;
const { party, parties: listParties, user, app } = resolvers.Query;

const createParty = async (ctx: ApolloContext, name = 'Party', password?: string) =>
  await parties().createParty({ input: { name, password } }, ctx) as any;

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
    expect(entered).toMatchObject({ status: 'ok', user: { name: '' } });
    expect(await jwt.jwtVerify<UserToken>(entered.userToken, 'UserToken')).toMatchObject({ sub: entered.user.id, email });

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

  it('falls back to the stored email when the session has none', async () => {
    const host = await signedIn('Host');
    expect(await createParty({ ...host, userEmail: undefined })).toMatchObject({ status: 'ok' });
  });

  it('needs a user to create a party', async () => {
    const ctx = await signedIn('Ghost', { retrieveUser: async () => null });
    expect(await createParty(ctx)).toMatchObject({ status: 'error', userErrors: [{ fieldName: null }] });
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

    expect(await parties().joinParty({ input: { party: node.id, name: 'G', password: undefined } }, guest)).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'password' }] });
    expect(await parties().joinParty({ input: { party: node.id, name: 'G', password: 'PW' } }, guest)).toMatchObject({ status: 'ok', node: { isJoined: true } });
    expect(await parties().leaveParty({ input: { party: node.id } }, guest)).toMatchObject({ status: 'ok', node: { isJoined: false } });
    await parties().joinParty({ input: { party: node.id, name: 'G', password: 'pw' } }, guest);
    expect(await parties().closeParty({ input: { party: node.id } }, host)).toMatchObject({ status: 'ok', node: { isClosed: true, target: { name: 'G' } } });
  });

  it('needs a session for join, leave and close', async () => {
    const id = nodeIdToStr({ kind: 'Party', id: 'QWERT' });
    const anonymous = context();
    expect(await parties().joinParty({ input: { party: id, name: 'x' } }, anonymous)).toMatchObject({ status: 'error', userErrors: [{ messages: ['You must be logged in before joining the party.'] }] });
    expect(await parties().leaveParty({ input: { party: id } }, anonymous)).toMatchObject({ status: 'error', userErrors: [{ messages: ['You must be logged in before leaving the party.'] }] });
    expect(await parties().closeParty({ input: { party: id } }, anonymous)).toMatchObject({ status: 'error', userErrors: [{ messages: ['You must be logged in before closing the party.'] }] });
  });

  it('needs a stored user to join', async () => {
    const ghost = await signedIn('Ghost', { retrieveUser: async () => null });
    const host = await signedIn('Host');
    const { node } = await createParty(host);
    expect(await parties().joinParty({ input: { party: node.id, name: 'x' } }, ghost)).toMatchObject({ status: 'error', userErrors: [{ fieldName: null }] });
  });

  it('rejects ids that are not parties', async () => {
    const ctx = await signedIn();
    const unknown = { status: 'error', userErrors: [{ fieldName: 'party', messages: ['Unknown input type. Must be Party.'] }] };
    for (const id of [nodeIdToStr({ kind: 'User', id: 'x' }), nodeIdToStr({ kind: 'Party', id: 'lower' }), '%%%']) {
      expect(await parties().joinParty({ input: { party: id, name: 'x' } }, ctx)).toMatchObject(unknown);
      expect(await parties().leaveParty({ input: { party: id } }, ctx)).toMatchObject(unknown);
      expect(await parties().closeParty({ input: { party: id } }, ctx)).toMatchObject(unknown);
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
    expect((await listParties(null, { first: 25 }, host)).map((p: any) => p.name)).toEqual(['B', 'A']);
    expect(await listParties(null, { first: 1000 }, host)).toHaveLength(2);
    expect(await listParties(null, { first: -5 }, host)).toEqual([]);
    expect(await listParties(null, { first: 25 }, context())).toEqual([]);
  });

  it('returns the signed-in user, or null', async () => {
    const ctx = await signedIn('Me');
    expect(await user(null, {}, ctx)).toMatchObject({ id: nodeIdToStr({ kind: 'User', id: ctx.userId! }), name: 'Me' });
    expect(await user(null, {}, context({ retrieveUser: async () => null }))).toBeNull();
  });

  it('maps a party view to a node, with and without a target', () => {
    expect(partyViewToNode(null)).toBeNull();
    const view = {
      id: 'x', slug: 'QWERT', name: 'P', password: null, isProtected: false, isHost: false, isJoined: true,
      isClosed: true, participantCount: 2, participants: ['A'], target: { id: 'a'.repeat(24), name: 'A' },
    };
    expect(partyViewToNode(view)).toMatchObject({ id: nodeIdToStr({ kind: 'Party', id: 'QWERT' }), target: { id: nodeIdToStr({ kind: 'User', id: 'a'.repeat(24) }), name: 'A' } });
    expect(partyViewToNode({ ...view, target: null })!.target).toBeNull();
  });
});

const info = (path: string[], operation: 'query' | 'mutation' = 'query') => {
  let node: any;
  for (const key of path) {
    node = { key, prev: node };
  }
  return { path: node, operation: { operation } } as unknown as GraphQLResolveInfo;
};

describe('middleware', () => {
  it('builds the field path', () => {
    expect(getPathFromInfo(info(['parties', 'createParty', 'node']))).toBe('parties.createParty.node');
    expect(getPathFromInfo(info(['app']))).toBe('app');
  });

  it('lets anonymous requests reach auth mutations, app and party, and nothing else', async () => {
    const resolve = vi.fn(async () => 'resolved');
    const anonymous = context();
    expect(await guardMiddleware(resolve, null, {}, anonymous, info(['auth', 'enter'], 'mutation'))).toBe('resolved');
    expect(await guardMiddleware(resolve, null, {}, anonymous, info(['auth']))).toBe('resolved');
    expect(await guardMiddleware(resolve, null, {}, anonymous, info(['app', 'name']))).toBe('resolved');
    expect(await guardMiddleware(resolve, null, {}, anonymous, info(['party']))).toBe('resolved');
    expect(await guardMiddleware(resolve, null, {}, anonymous, info(['user']))).toBeNull();
    await expect(guardMiddleware(resolve, null, {}, anonymous, info(['parties', 'createParty'], 'mutation'))).rejects.toThrow('UNAUTHENTICATED');

    const ctx = await signedIn();
    expect(await guardMiddleware(resolve, null, {}, ctx, info(['user']))).toBe('resolved');
  });

  it('verifies the session once per request and exposes the user', async () => {
    const email = uniqueEmail();
    const stored = await env.USER.getByName(email).ensure(email);
    const token = await jwt.issueToken<UserToken>('UserToken', { sub: nodeIdToStr({ kind: 'User', id: stored.id }), email }, { ttl: 60 });
    const ctx = context({ authToken: token });
    const verify = vi.spyOn(ctx, 'jwtVerify');
    const resolve = async (_root: unknown, _args: unknown, c: ApolloContext) => c.userId;

    const results = await Promise.all([
      authMiddleware(resolve, null, {}, ctx, info(['user'])),
      authMiddleware(resolve, null, {}, ctx, info(['parties'])),
    ]);
    expect(results).toEqual([stored.id, stored.id]);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(await ctx.retrieveUser()).toMatchObject({ id: stored.id, email });
  });

  it('drops invalid sessions', async () => {
    const email = uniqueEmail();
    const resolve = async (_root: unknown, _args: unknown, c: ApolloContext) => [c.userId, c.authToken];
    const tokens = [
      'garbage',
      await jwt.issueToken<UserToken>('UserToken', { sub: nodeIdToStr({ kind: 'Party', id: 'QWERT' }), email }, { ttl: 60 }),
      await jwt.issueToken('UserToken', { sub: nodeIdToStr({ kind: 'User', id: 'a'.repeat(24) }) }, { ttl: 60 }),
    ];
    for (const authToken of tokens) {
      expect(await authMiddleware(resolve, null, {}, context({ authToken }), info(['user']))).toEqual([undefined, undefined]);
    }
    expect(await authMiddleware(resolve, null, {}, context(), info(['user']))).toEqual([undefined, undefined]);
  });
});

describe('resolvable', () => {
  const schema = yup.object({ name: yup.string().trim().required() });
  const handler = resolvable(schema)(async (input: { name: string }) => ({ node: { id: input.name } }));

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

  it('reads the client IP and bearer token', async () => {
    const ctx = await makeContext(honoContext({ 'cf-connecting-ip': '203.0.113.1', authorization: 'Bearer abc' }));
    expect(ctx).toMatchObject({ clientIp: '203.0.113.1', authToken: 'abc', userId: undefined });
    await expect(ctx.retrieveUser()).rejects.toThrow('Unable to retrieve user');
  });

  it('copes with missing headers', async () => {
    expect(await makeContext(honoContext({}))).toMatchObject({ clientIp: 'unknown', authToken: undefined });
  });

  it('sends mail through the EMAIL binding', async () => {
    const send = vi.fn(async () => ({ messageId: 'm' }));
    const ctx = await makeContext({ env: { ...env, EMAIL: { send } }, req: { header: () => undefined } } as any);
    await ctx.sendMail('to@example.com', { subject: 's', html: 'h', text: 't' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'to@example.com', subject: 's', html: 'h', text: 't' }));
  });
});
