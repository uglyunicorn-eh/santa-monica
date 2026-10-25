// Read-only checks against a deployed Worker. Run after every deploy.
// Usage: SMOKE_URL=https://gnomik-api.<account>.workers.dev npm run smoke
const base = process.env.SMOKE_URL ?? process.argv[2];

if (!base) {
  console.error('Set SMOKE_URL (or pass the URL as the first argument).');
  process.exit(1);
}

type Check = { name: string; run: () => Promise<void> };

const assert = (condition: unknown, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(new URL(path, base), init);
  return { status: res.status, body: await res.json() as any, headers: res.headers };
};

const checks: Check[] = [
  {
    name: 'app info',
    run: async () => {
      const res = await fetch(new URL('/', base));
      assert(res.ok, `/ answered HTTP ${res.status}`);
      const body = await res.json() as { status?: string; name?: string };
      assert(body.status === 'ok' && body.name === 'santa-monica', `unexpected body ${JSON.stringify(body)}`);
    },
  },
  {
    name: 'unknown party is 404',
    run: async () => {
      const { status, body } = await api('/v1/parties/QQQQQ');
      assert(status === 404 && body?.error?.code === 'not_found', `unexpected response ${status} ${JSON.stringify(body)}`);
    },
  },
  {
    name: 'no session is 401',
    run: async () => {
      const { status, body } = await api('/v1/me');
      assert(status === 401 && body?.error?.code === 'unauthenticated', `unexpected response ${status} ${JSON.stringify(body)}`);
    },
  },
  {
    name: 'invalid input is 400',
    run: async () => {
      const { status, body } = await api('/v1/auth/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"nope"}' });
      assert(status === 400 && body?.error?.field === 'email', `unexpected response ${status} ${JSON.stringify(body)}`);
    },
  },
  {
    name: 'the old GraphQL route is gone',
    run: async () => {
      const { status } = await api('/graph/', { method: 'POST' });
      assert(status === 404, `/graph/ answered HTTP ${status}`);
    },
  },
  {
    name: 'CORS preflight',
    run: async () => {
      const res = await fetch(new URL('/v1/parties', base), {
        method: 'OPTIONS',
        headers: { origin: 'https://gnomik.me', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,idempotency-key' },
      });
      const allowed = res.headers.get('access-control-allow-headers') ?? '';
      assert(res.status === 204 && res.headers.get('access-control-allow-origin') === '*' && allowed.includes('idempotency-key'), `preflight answered HTTP ${res.status} (${allowed})`);
    },
  },
  {
    name: 'email images',
    run: async () => {
      for (const file of ['gnomik.png', 'uglyunicorn.png', 'party.gif']) {
        const res = await fetch(new URL(`/email/${file}`, base));
        assert(res.ok, `/email/${file} answered HTTP ${res.status}`);
      }
    },
  },
];

// A freshly deployed Worker (especially a new preview hostname) can answer 404 for a few seconds, so wait until it
// serves / before checking anything.
const READY_TIMEOUT_MS = 60_000;
const startedAt = Date.now();
while (true) {
  const status = await fetch(new URL('/', base)).then(res => res.status, () => 0);
  if (status === 200) {
    break;
  }
  if (Date.now() - startedAt > READY_TIMEOUT_MS) {
    console.log(`FAIL ${base} did not come up within ${READY_TIMEOUT_MS / 1000}s (last status ${status})`);
    process.exit(1);
  }
  await new Promise(resolve => setTimeout(resolve, 3000));
}

let failed = 0;
for (const check of checks) {
  try {
    await check.run();
    console.log(`ok   ${check.name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
process.exitCode = failed ? 1 : 0;
