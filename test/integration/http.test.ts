import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { MAX_BODY_BYTES } from 'src/api/limits';

import { api, apiError, call, signIn, uniqueEmail, uniqueIp } from './support';

import { version } from 'package.json';

describe('HTTP surface', () => {
  it('serves the app info with the usual headers', async () => {
    const res = await api('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok', name: 'santa-monica', version, github: 'https://github.com/uglyunicorn-eh/santa-monica',
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
    expect(res.headers.get('access-control-allow-origin')).toBe('https://gnomik.me');
    expect(res.headers.get('access-control-allow-methods')).toContain('PATCH');
    expect(res.headers.get('access-control-allow-headers')).toBe('authorization,content-type,idempotency-key');
  });

  it('lets only the listed origins read the answers', async () => {
    const from = (origin: string) => api('/', { headers: { origin } });
    expect((await from('https://gnomik.me')).headers.get('access-control-allow-origin')).toBe('https://gnomik.me');
    expect((await from('https://pr-12.gnomik-me.pages.dev')).headers.get('access-control-allow-origin')).toBe('https://pr-12.gnomik-me.pages.dev');
    for (const origin of ['https://evil.example', 'https://gnomik.me.evil.example', 'null']) {
      const res = await from(origin);
      expect([origin, res.status, res.headers.get('access-control-allow-origin')]).toEqual([origin, 200, null]);
    }
  });

  it('answers 404 with the error shape for unknown routes, including the old GraphQL one', async () => {
    for (const path of ['/nope', '/graph', '/graph/', '/v1/nope']) {
      const res = await api(path, { method: 'POST' });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(apiError('not_found', 'Not found.'));
    }
  });

  it('never takes the party code from the path, so request logs never record it: writes take it in the body', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = (await call('POST', '/v1/parties', { token: host.token, body: { name: 'Query' } })).body;
    expect((await call('GET', `/v1/parties?code=${party.code.toLowerCase()}`)).body).toMatchObject({ code: party.code });
    expect(await call('GET', '/v1/parties')).toEqual({ status: 404, body: apiError('not_found', 'Party does not exist.', 'party') });
    // The old routes with the code in the path are gone.
    for (const [method, path] of [['GET', ''], ['POST', '/join'], ['POST', '/draw'], ['DELETE', '']]) {
      const res = await call(method, `/v1/parties/${party.code}${path}`, { token: host.token, body: method === 'POST' ? {} : undefined });
      expect([method, path, res.status, res.body.error.code]).toEqual([method, path, 404, 'not_found']);
    }
    expect((await call('DELETE', `/v1/parties?code=${party.code}`, { token: host.token })).status).toBe(404);
    // A code in the query string of a write is not read: the body must carry it.
    expect(await call('POST', `/v1/parties/draw?code=${party.code}`, { token: host.token, body: {} })).toMatchObject({
      status: 400, body: apiError('invalid', 'Invalid party code', 'code'),
    });
    expect((await call('POST', '/v1/parties/delete', { token: host.token, body: { code: party.code.toLowerCase() } })).status).toBe(200);
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
      ['POST', '/v1/parties/join', { code: 'QWERTYUI', name: long(101) }],
      ['POST', '/v1/parties/join', { code: 'QWERTYUI', name: 'Ok', password: long(101) }],
      ['POST', '/v1/parties/leave', { code: 'Q'.repeat(101) }],
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
    expect((await call('GET', `/v1/parties?code=${'Q'.repeat(500)}`)).status).toBe(404);
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

  it('allows ten lookups of old 5-letter codes a minute from one address; 8-letter codes have their own limit', async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 10; i++) {
      expect((await call('GET', '/v1/parties?code=QWERT', { ip })).status).toBe(404);
    }
    expect(await call('GET', '/v1/parties?code=QWERT', { ip })).toEqual({ status: 429, body: apiError('rate_limited', expect.any(String)) });
    expect((await call('GET', '/v1/parties?code=QWERTYUI', { ip })).status).toBe(404);
  });
});
