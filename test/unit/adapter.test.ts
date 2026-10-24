import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

const createServer = vi.hoisted(() => vi.fn());

vi.mock('src/apollo/index', async importOriginal => {
  const original = await importOriginal<typeof import('src/apollo/index')>();
  createServer.mockImplementation(original.createServer);
  return { createServer };
});

const { app } = await import('src/index');

describe('Apollo startup', () => {
  it('retries a failed start on the next request instead of caching the failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createServer.mockRejectedValueOnce(new Error('start failed'));
    const query = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ app { name } }' }) };

    expect((await app.request('/graph', query, env)).status).toBe(500);
    const res = await app.request('/graph', query, env);
    expect(await res.json()).toEqual({ data: { app: { name: 'santa-monica' } } });
    expect(createServer).toHaveBeenCalledTimes(2);

    await app.request('/graph', query, env);
    expect(createServer).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
