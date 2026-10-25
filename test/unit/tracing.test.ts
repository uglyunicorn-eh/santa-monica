import { tracing } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { env } from 'cloudflare:test';

import { partyRef } from 'src/utils/logRef';
import { annotate, recordOutcome, withSpan } from 'src/utils/tracing';

import { jwt, request, signIn } from './helpers';

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

describe('recordOutcome', () => {
  it('records ok for a success', () => {
    const span = fakeSpan('s');
    recordOutcome(span as unknown as Span);
    expect(span.attributes).toEqual({ 'api.status': 'ok' });
  });

  it('records the error code and field of a failure, with - for one about no field', () => {
    const span = fakeSpan('s');
    recordOutcome(span as unknown as Span, { code: 'invalid', field: 'party' });
    expect(span.attributes).toEqual({ 'api.status': 'error', 'api.error_code': 'invalid', 'api.user_error_fields': 'party' });
    const other = fakeSpan('o');
    recordOutcome(other as unknown as Span, { code: 'conflict' });
    expect(other.attributes).toEqual({ 'api.status': 'error', 'api.error_code': 'conflict', 'api.user_error_fields': '-' });
  });
});

describe('API action spans', () => {
  it('records one span per request with the action, user, outcome and party code, and no personal data', async () => {
    const who = await signIn();
    const spans = captureSpans();

    const created = await request('POST', '/v1/parties', { token: who.token, body: { name: 'Spans party', password: 'pw' } });
    const invalid = await request('POST', '/v1/parties', { token: who.token, body: { name: '' } });

    expect([created.status, invalid.status]).toEqual([201, 400]);
    expect(spans.map(s => s.name)).toEqual(['api.createParty', 'api.createParty']);
    expect(spans[0].attributes).toMatchObject({
      'api.action': 'createParty', 'user.id': who.id, 'api.status': 'ok',
      'party.protected': true, 'party.ref': await partyRef(env, created.body.code), 'party.code_attempts': 1,
    });
    expect(spans[1].attributes).toMatchObject({ 'api.status': 'error', 'api.error_code': 'invalid', 'api.user_error_fields': 'name' });
    expect(JSON.stringify(spans)).not.toContain(who.email);
    expect(JSON.stringify(spans)).not.toContain(created.body.code);
  });

  it('records spans for reads', async () => {
    const who = await signIn();
    const { body: party } = await request('POST', '/v1/parties', { token: who.token, body: { name: 'Query spans' } });
    const spans = captureSpans();

    await request('GET', `/v1/parties/${party.code}`, { token: who.token });
    await request('GET', '/v1/me/parties', { token: who.token });
    await request('GET', '/v1/me', { token: who.token });

    expect(spans.map(s => s.name)).toEqual(['api.party', 'api.partyHistory', 'api.user']);
    expect(spans[0].attributes).toMatchObject({ 'party.ref': await partyRef(env, party.code), 'party.found': true, 'party.joined': true });
    // The code itself is never recorded: it is the key to a party without a secret phrase.
    expect(JSON.stringify(spans)).not.toContain(party.code);
    expect(spans[1].attributes).toMatchObject({ 'parties.first': 10, 'parties.count': 1 });
    expect(spans[2].attributes).toMatchObject({ 'user.id': who.id, 'user.found': true });
  });

  it('records how a magic link was used', async () => {
    const spans = captureSpans();
    const token = await jwt().issueToken('EnterRequest', { email: `link-${Date.now()}@example.com`, jti: crypto.randomUUID() }, { ttl: 60 });

    await request('POST', '/v1/auth/session', { body: { token } });
    await request('POST', '/v1/auth/session', { body: { token } });
    await request('POST', '/v1/auth/session', { body: { token: 'garbage' } });

    expect(spans.map(s => s.attributes['auth.magic_link'])).toEqual(['redeemed', 'already_used', 'invalid']);
  });
});

describe('partyRef', () => {
  it('refers to a party by a stable keyed hash of its code, never the code', async () => {
    const ref = await partyRef(env, 'QWERTYUI');
    expect(ref).toMatch(/^[0-9a-f]{12}$/);
    expect(await partyRef(env, 'QWERTYUI')).toBe(ref);
    expect(await partyRef(env, 'QWERTYUP')).not.toBe(ref);
    // Another key gives other refs, so a ref can't be matched to a code without the key.
    expect(await partyRef({ ...env, JWT_PRIVATE_KEY: env.TEST_OTHER_PRIVATE_KEY } as typeof env, 'QWERTYUI')).not.toBe(ref);
  });
});
