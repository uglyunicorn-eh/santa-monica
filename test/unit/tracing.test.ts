import { env } from 'cloudflare:test';
import { tracing } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApolloContext } from 'src/apollo/context';
import mutations from 'src/apollo/mutations';
import resolvers from 'src/apollo/resolvers';
import { createJwtHelpers } from 'src/utils/jwt';
import { annotate, recordResult, withSpan } from 'src/utils/tracing';

import { domain } from 'src/config.json';

type FakeSpan = {
  name: string;
  attributes: Record<string, unknown>;
  exceptions: unknown[];
  setAttribute(key: string, value: unknown): FakeSpan;
  setAttributes(attributes: Record<string, unknown>): FakeSpan;
  recordException(exception: unknown): void;
};

const fakeSpan = (name: string): FakeSpan => {
  const span: FakeSpan = {
    name,
    attributes: {},
    exceptions: [],
    setAttribute(key, value) {
      if (value !== undefined) span.attributes[key] = value;
      return span;
    },
    setAttributes(attributes) {
      for (const [key, value] of Object.entries(attributes)) span.setAttribute(key, value);
      return span;
    },
    recordException(exception) {
      span.exceptions.push(exception);
    },
  };
  return span;
};

/** Replaces Workers tracing with fake spans, so tests can see what each action records. */
function captureSpans() {
  const spans: FakeSpan[] = [];
  const stack: FakeSpan[] = [];
  vi.spyOn(tracing, 'enterSpan').mockImplementation(((name: string, callback: (span: any) => any) => {
    const span = fakeSpan(name);
    spans.push(span);
    stack.push(span);
    const done = () => stack.pop();
    const result = callback(span);
    return result instanceof Promise ? result.finally(done) : (done(), result);
  }) as any);
  vi.spyOn(tracing, 'getActiveSpan').mockImplementation((() => stack.at(-1)) as any);
  return spans;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withSpan', () => {
  it('runs the callback in a span with the given attributes and returns its result', async () => {
    const spans = captureSpans();
    expect(await withSpan('api.test', { 'a': 1, 'skipped': undefined }, async () => 'done')).toBe('done');
    expect(spans).toMatchObject([{ name: 'api.test', attributes: { a: 1 }, exceptions: [] }]);
    expect(spans[0].attributes).not.toHaveProperty('skipped');
  });

  it('records thrown errors on the span and rethrows them', async () => {
    const spans = captureSpans();
    const error = new Error('boom');
    await expect(withSpan('api.fail', {}, async () => { throw error; })).rejects.toBe(error);
    await expect(withSpan('api.fail', {}, async () => { throw 'plain string'; })).rejects.toBe('plain string');
    expect(spans.map(s => s.exceptions)).toEqual([[error], ['plain string']]);
  });

  it('works with the real Workers tracing API', async () => {
    expect(await withSpan('api.real', { 'a': 'b' }, async span => {
      annotate({ 'c': 'd' });
      return typeof span.setAttribute;
    })).toBe('function');
  });
});

describe('recordResult', () => {
  it('records ok when there are no user errors', () => {
    const span = fakeSpan('s');
    recordResult(span as unknown as Span, {});
    expect(span.attributes).toEqual({ 'api.status': 'ok' });
  });

  it('records the status and the fields of user errors, with - for errors without a field', () => {
    const span = fakeSpan('s');
    recordResult(span as unknown as Span, { status: 'error', userErrors: [{ fieldName: 'party' }, { fieldName: null }] });
    expect(span.attributes).toEqual({ 'api.status': 'error', 'api.user_error_fields': 'party,-' });
  });
});

describe('API action spans', () => {
  const jwt = createJwtHelpers({ privateKey: env.JWT_PRIVATE_KEY, issuer: domain });
  let counter = 0;

  const signedIn = async (): Promise<ApolloContext> => {
    const email = `spans-${Date.now().toString(36)}-${++counter}@example.com`;
    const user = await env.USER.getByName(email).ensure(email);
    return {
      env, clientIp: `198.51.100.${counter}`, userId: user.id, userEmail: email,
      retrieveUser: async () => await env.USER.getByName(email).get(),
      sendMail: async () => undefined,
      ...jwt,
    };
  };

  it('records one span per mutation with the action, user, outcome and party code, and no personal data', async () => {
    const ctx = await signedIn();
    const spans = captureSpans();

    const created = await mutations.Mutation.parties(null, {}, ctx).createParty({ input: { name: 'Spans party', password: 'pw' } }, ctx) as any;
    const invalid = await mutations.Mutation.parties(null, {}, ctx).createParty({ input: { name: '' } }, ctx) as any;

    expect(created.status).toBe('ok');
    expect(invalid.status).toBe('error');
    expect(spans.map(s => s.name)).toEqual(['api.createParty', 'api.createParty']);
    expect(spans[0].attributes).toMatchObject({
      'api.action': 'createParty', 'user.id': ctx.userId, 'api.status': 'ok',
      'party.protected': true, 'party.code': created.node.code, 'party.code_attempts': 1,
    });
    expect(spans[1].attributes).toMatchObject({ 'api.status': 'error', 'api.user_error_fields': 'name' });
    expect(JSON.stringify(spans)).not.toContain(ctx.userEmail);
  });

  it('records spans for queries', async () => {
    const ctx = await signedIn();
    const created = await mutations.Mutation.parties(null, {}, ctx).createParty({ input: { name: 'Query spans' } }, ctx) as any;
    const spans = captureSpans();

    await resolvers.Query.party(null, { code: created.node.code }, ctx);
    await resolvers.Query.parties(null, { first: 10 }, ctx);
    await resolvers.Query.user(null, {}, ctx);

    expect(spans.map(s => s.name)).toEqual(['api.party', 'api.parties', 'api.user']);
    expect(spans[0].attributes).toMatchObject({ 'party.code': created.node.code, 'party.found': true, 'party.joined': true });
    expect(spans[1].attributes).toMatchObject({ 'parties.first': 10, 'parties.count': 1 });
    expect(spans[2].attributes).toMatchObject({ 'user.id': ctx.userId, 'user.found': true });
  });

  it('records how a magic link was used', async () => {
    const spans = captureSpans();
    const token = await jwt.issueToken('EnterRequest', { email: `link-${++counter}@example.com`, jti: crypto.randomUUID() }, { ttl: 60 });
    const context = { env, clientIp: '198.51.100.250', retrieveUser: async () => null, sendMail: async () => undefined, ...jwt } as ApolloContext;

    await mutations.Mutation.auth().enter({ input: { enterRequestToken: token } }, context);
    await mutations.Mutation.auth().enter({ input: { enterRequestToken: token } }, context);
    await mutations.Mutation.auth().enter({ input: { enterRequestToken: 'garbage' } }, context);

    expect(spans.map(s => s.attributes['auth.magic_link'])).toEqual(['redeemed', 'already_used', 'invalid']);
  });
});
