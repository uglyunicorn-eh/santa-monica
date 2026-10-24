import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import worker, { app } from 'src/index';

const post = (path: string, body: string, headers: Record<string, string> = {}, bindings: object = env) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }, bindings);

describe('Hono app', () => {
  it('answers / with the app info and the custom headers', async () => {
    const res = await app.request('/', {}, env);
    expect(await res.json()).toEqual({ status: 'ok', name: 'santa-monica', version: '4.0.0', github: 'https://github.com/uglyunicorn-eh/santa-monica' });
    expect(res.headers.get('X-Developed-By')).toContain('Ugly Unicorn');
  });

  it('serves GraphQL over POST and GET', async () => {
    const viaPost = await post('/graph', JSON.stringify({ query: '{ app { name } }' }));
    expect(await viaPost.json()).toEqual({ data: { app: { name: 'santa-monica' } } });
    expect(viaPost.headers.get('content-type')).toContain('application/json');

    const viaGet = await app.request(`/graph?query=${encodeURIComponent('{ app { name } }')}`, { headers: { 'apollo-require-preflight': '1' } }, env);
    expect(await viaGet.json()).toEqual({ data: { app: { name: 'santa-monica' } } });
  });

  it('serves GraphQL with and without a trailing slash, as the frontend calls /graph/', async () => {
    for (const path of ['/graph', '/graph/']) {
      const res = await post(path, JSON.stringify({ query: '{ app { name } }' }));
      expect(await res.json()).toEqual({ data: { app: { name: 'santa-monica' } } });
    }
  });

  it('passes through the status Apollo picks for invalid queries', async () => {
    const res = await post('/graph', JSON.stringify({ query: '{ nope }' }));
    expect(res.status).toBe(400);
    expect((await res.json() as any).errors[0].message).toMatch(/nope/);
  });

  it('answers 400 for an unparseable body', async () => {
    const res = await post('/graph', 'not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ status: 'error', error: 'Invalid JSON body' });
  });

  it('turns unexpected errors into a 500 with an error id', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await post('/admin/import', 'not json', { 'x-admin-secret': env.ADMIN_SECRET! });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ status: 'error', error: 'Ugly Unicorn just puked a little bit :(' });
    error.mockRestore();
  });
});

describe('admin import', () => {
  const empty = JSON.stringify({ users: [], parties: [] });

  it('is hidden when no secret is configured', async () => {
    const res = await post('/admin/import', empty, { 'x-admin-secret': 'anything' }, { ...env, ADMIN_SECRET: undefined });
    expect(res.status).toBe(404);
  });

  it('is hidden when the request has no secret', async () => {
    expect((await post('/admin/import', empty)).status).toBe(404);
  });

  it('is hidden for a wrong secret of any length', async () => {
    const wrongSameLength = env.ADMIN_SECRET!.replace(/./, c => (c === 'x' ? 'y' : 'x'));
    for (const secret of ['short', wrongSameLength, `${env.ADMIN_SECRET}-longer`]) {
      expect((await post('/admin/import', empty, { 'x-admin-secret': secret })).status).toBe(404);
    }
  });

  it('imports with the right secret', async () => {
    const res = await post('/admin/import', empty, { 'x-admin-secret': env.ADMIN_SECRET! });
    expect(await res.json()).toEqual({ status: 'ok', imported: { users: 0, userParties: 0, parties: 0, memberships: 0 } });
  });

  it('imports users and parties and adds up what it imported', async () => {
    const [a, b] = ['a'.repeat(24), 'b'.repeat(24)];
    const snapshot = {
      users: [
        { id: a, email: 'unit-import-a@example.com', name: 'A', joined: 1, parties: [{ slug: 'UNITA', name: 'P', createdAt: 1 }] },
        { id: b, email: 'unit-import-b@example.com', name: 'B', joined: 1, parties: [{ slug: 'UNITA', name: 'P', createdAt: 1 }] },
      ],
      parties: [{
        id: 'c'.repeat(24), slug: 'UNITA', name: 'P', password: null, hostId: a, isClosed: false, createdAt: 1,
        members: [
          { id: a, email: 'unit-import-a@example.com', name: 'A', targetId: null, targetName: null, joinedAt: 1 },
          { id: b, email: 'unit-import-b@example.com', name: 'B', targetId: null, targetName: null, joinedAt: 2 },
        ],
      }],
    };
    const res = await post('/admin/import', JSON.stringify(snapshot), { 'x-admin-secret': env.ADMIN_SECRET! });
    expect(await res.json()).toEqual({ status: 'ok', imported: { users: 2, userParties: 2, parties: 1, memberships: 2 } });
  });
});

describe('Worker entry point', () => {
  const fetchVia = async (bindings: object) => {
    const ctx = createExecutionContext();
    const res = await worker.fetch!(new Request('https://api.test/') as any, bindings as any, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };

  it('serves requests without Sentry when no DSN is set', async () => {
    expect((await fetchVia({ ...env, SENTRY_DSN: undefined })).status).toBe(200);
  });

  it('serves requests with Sentry enabled', async () => {
    const res = await fetchVia({ ...env, SENTRY_DSN: 'https://public@127.0.0.1:9/1' });
    expect(res.status).toBe(200);
  });
});
