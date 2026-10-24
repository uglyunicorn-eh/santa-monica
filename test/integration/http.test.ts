import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { api } from './support';

describe('HTTP surface', () => {
  it('serves the app info with the usual headers', async () => {
    const res = await api('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok', name: 'santa-monica', version: expect.any(String), author: 'Ugly Unicorn <info@uglyunicorn.ca>',
    });
    expect(res.headers.get('X-Powered-By')).toBe('Maple syrup and magic, eh!');
    expect(res.headers.get('X-Developed-By')).toContain('Ugly Unicorn');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('answers CORS preflight for the frontend', async () => {
    const res = await api('/graph', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://gnomik.me',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('serves GraphQL queries over GET with the preflight header', async () => {
    const res = await api(`/graph?query=${encodeURIComponent('{ app { name } }')}`, {
      headers: { 'apollo-require-preflight': 'true' },
    });
    expect(await res.json()).toEqual({ data: { app: { name: 'santa-monica' } } });
  });

  it('blocks GET queries that could be cross-site requests', async () => {
    const res = await api(`/graph?query=${encodeURIComponent('{ app { name } }')}`);
    expect(res.status).toBe(400);
  });

  it('refuses mutations over GET', async () => {
    const res = await api(`/graph?query=${encodeURIComponent('mutation { parties { createParty(input: { name: "x" }) { status } } }')}`, {
      headers: { 'apollo-require-preflight': 'true' },
    });
    expect(res.status).toBe(405);
  });

  it('answers 400 for an invalid JSON body', async () => {
    const res = await api('/graph', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(res.status).toBe(400);
  });

  it('reports GraphQL errors for unknown fields', async () => {
    const res = await api('/graph', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ nope }' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).errors[0].message).toMatch(/nope/);
  });

  it('answers 404 for unknown routes', async () => {
    expect((await api('/nope')).status).toBe(404);
  });

  it('serves the email images', async () => {
    const assets = (env as unknown as { ASSETS: Fetcher }).ASSETS;
    for (const [file, type] of [['gnomik.png', 'image/png'], ['uglyunicorn.png', 'image/png'], ['party.gif', 'image/gif']]) {
      const res = await assets.fetch(`https://api.test/email/${file}`);
      expect([res.status, res.headers.get('content-type')]).toEqual([200, type]);
    }
  });
});
