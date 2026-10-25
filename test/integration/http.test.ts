import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { MAX_BODY_BYTES } from 'src/api/limits';

import { api, apiError, call, signIn, uniqueEmail } from './support';

describe('HTTP surface', () => {
  it('serves the app info with the usual headers', async () => {
    const res = await api('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok', name: 'santa-monica', version: '4.0.0', github: 'https://github.com/uglyunicorn-eh/santa-monica',
    });
    expect(res.headers.get('X-Powered-By')).toBe('Maple syrup and magic, eh!');
    expect(res.headers.get('X-Developed-By')).toContain('Ugly Unicorn');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('answers CORS preflight for the frontend, including the Idempotency-Key header', async () => {
    const res = await api('/v1/parties', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://gnomik.me',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization,idempotency-key',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('PATCH');
    expect(res.headers.get('access-control-allow-headers')).toBe('authorization,content-type,idempotency-key');
  });

  it('answers 404 with the error shape for unknown routes, including the old GraphQL one', async () => {
    for (const path of ['/nope', '/graph', '/graph/', '/v1/nope']) {
      const res = await api(path, { method: 'POST' });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(apiError('not_found', 'Not found.'));
    }
  });

  it('accepts a trailing slash on the routes', async () => {
    const person = await signIn(uniqueEmail());
    expect((await call('GET', '/v1/me/', { token: person.token })).status).toBe(200);
  });

  it('refuses a body over the size limit before reading it', async () => {
    const res = await api('/v1/auth/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x'.repeat(MAX_BODY_BYTES) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual(apiError('invalid', 'The request is too large.'));
  });

  it('refuses bodies that are not a JSON object, unknown fields and non-text values', async () => {
    const post = (body: string) => api('/v1/auth/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    for (const [body, message] of [
      ['{', 'The request body must be JSON.'],
      ['[]', 'The request body must be a JSON object.'],
      ['"text"', 'The request body must be a JSON object.'],
      ['null', 'The request body must be a JSON object.'],
      ['{"email":"a@example.com","admin":true}', 'Unknown field: admin.'],
      ['{"email":42}', 'Must be text.'],
      ['{"email":{"$gt":""}}', 'Must be text.'],
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject(apiError('invalid', message));
    }
  });

  it('bounds every text field', async () => {
    const person = await signIn(uniqueEmail());
    const long = (n: number) => 'x'.repeat(n);
    const cases: [string, string, object][] = [
      ['POST', '/v1/auth/magic-link', { email: `${long(120)}@example.com` }],
      ['POST', '/v1/auth/session', { token: long(2049) }],
      ['PATCH', '/v1/me', { name: long(101) }],
      ['POST', '/v1/me/email-change', { email: `${long(120)}@example.com` }],
      ['POST', '/v1/me/email-change/confirm', { token: long(2049) }],
      ['POST', '/v1/me/deletion/confirm', { token: long(2049) }],
      ['POST', '/v1/parties', { name: long(101) }],
      ['POST', '/v1/parties', { name: 'Ok', password: long(101) }],
      ['POST', '/v1/parties/QWERTYUI/join', { name: long(101) }],
      ['POST', '/v1/parties/QWERTYUI/join', { name: 'Ok', password: long(101) }],
    ];
    for (const [method, path, body] of cases) {
      const res = await call(method, path, { token: person.token, body });
      expect([path, res.status, res.body.error.code]).toEqual([path, 400, 'invalid']);
    }
  });

  it('bounds the query string, the path and the headers it reads', async () => {
    const person = await signIn(uniqueEmail());
    for (const query of ['?first=0', '?first=101', '?first=abc', '?first=1000', `?after=${'x'.repeat(101)}`, '?after=', '?after=bm9wZQ']) {
      expect((await call('GET', `/v1/me/parties${query}`, { token: person.token })).status).toBe(400);
    }
    expect((await call('GET', `/v1/parties/${'Q'.repeat(500)}`)).status).toBe(404);
    expect((await call('GET', '/v1/me', { headers: { authorization: `Bearer ${'a'.repeat(3000)}.b.c` } })).status).toBe(401);
    expect((await call('GET', '/v1/me', { headers: { authorization: 'Basic abc' } })).status).toBe(401);
  });

  it('serves the email images', async () => {
    const assets = (env as unknown as { ASSETS: Fetcher }).ASSETS;
    for (const [file, type] of [['gnomik.png', 'image/png'], ['uglyunicorn.png', 'image/png'], ['party.gif', 'image/gif']]) {
      const res = await assets.fetch(`https://api.test/email/${file}`);
      expect([res.status, res.headers.get('content-type')]).toEqual([200, type]);
    }
  });
});
