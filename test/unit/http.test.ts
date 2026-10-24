import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import worker, { app } from 'src/index';

// A route that fails, to exercise the app's error handler. Routes can only be added before the first request.
app.get('/__test/throw', () => { throw new Error('boom'); });

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

  it('turns unexpected errors into a 500 and logs them with the same error id', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await app.request('/__test/throw', {}, env);
    expect(res.status).toBe(500);
    const body = await res.json() as { status: string; error: string; errorId: string };
    expect(body).toMatchObject({ status: 'error', error: 'Ugly Unicorn just puked a little bit :(' });
    expect(body.errorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'Unhandled error', errorId: body.errorId, path: '/__test/throw', error: 'Error: boom' }));
    error.mockRestore();
  });
});


describe('Worker entry point', () => {
  const fetchVia = async (bindings: object) => {
    const ctx = createExecutionContext();
    const res = await worker.fetch!(new Request('https://api.test/') as any, bindings as any, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };

  it('serves requests through the Hono app', async () => {
    const res = await fetchVia(env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', name: 'santa-monica' });
  });
});
