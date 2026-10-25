import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { fail } from 'src/api/errors';
import worker, { app } from 'src/index';

// Routes that fail, to exercise the app's error handler. Routes can only be added before the first request.
app.get('/__test/throw', () => { throw new Error('boom'); });
app.get('/__test/expected', () => { throw fail('conflict', 'Expected failure.', 'thing'); });

describe('Hono app', () => {
  it('answers / with the app info and the custom headers', async () => {
    const res = await app.request('/', {}, env);
    expect(await res.json()).toEqual({ status: 'ok', name: 'santa-monica', version: '4.0.0', github: 'https://github.com/uglyunicorn-eh/santa-monica' });
    expect(res.headers.get('X-Developed-By')).toContain('Ugly Unicorn');
  });

  it('answers 404 with the error shape, for the old GraphQL route too', async () => {
    for (const path of ['/nope', '/graph', '/v1']) {
      const res = await app.request(path, { method: 'POST' }, env);
      expect([res.status, await res.json()]).toEqual([404, { error: { code: 'not_found', message: 'Not found.' } }]);
    }
  });

  it('answers an expected failure thrown outside a route action with its own status and body', async () => {
    const res = await app.request('/__test/expected', {}, env);
    expect([res.status, await res.json()]).toEqual([409, { error: { code: 'conflict', message: 'Expected failure.', field: 'thing' } }]);
  });

  it('turns unexpected errors into a 500 that hides them, logged with the same error id', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const [path, message] of [['/__test/throw', 'Error: boom']]) {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(500);
      const body = await res.json() as { error: { code: string; message: string; errorId: string } };
      expect(body.error).toMatchObject({ code: 'internal', message: 'Ugly Unicorn just puked a little bit :(' });
      expect(body.error.errorId).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.stringify(body)).not.toContain(message);
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'Unhandled error', errorId: body.error.errorId, path, error: message }));
    }
    error.mockRestore();
  });
});

describe('Worker entry point', () => {
  it('serves requests through the Hono app', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch!(new Request('https://api.test/') as any, env as any, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', name: 'santa-monica' });
  });
});
