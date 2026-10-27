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
    name: "Party'o'meter answers a count",
    run: async () => {
      const { status, body } = await api('/v1/stats');
      assert(status === 200 && Number.isInteger(body?.rolled), `unexpected response ${status} ${JSON.stringify(body)}`);
    },
  },
  {
    name: 'unknown party is 404',
    run: async () => {
      const { status, body } = await api('/v1/parties?code=QQQQQ');
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
    name: 'CORS allows only the listed origins',
    run: async () => {
      const preflight = (origin: string) => fetch(new URL('/v1/parties', base), {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,idempotency-key' },
      });
      const res = await preflight('https://gnomik.me');
      const allowed = res.headers.get('access-control-allow-headers') ?? '';
      const origin = res.headers.get('access-control-allow-origin');
      assert(res.status === 204 && origin === 'https://gnomik.me' && allowed.includes('idempotency-key'), `preflight answered HTTP ${res.status} (${origin}; ${allowed})`);
      const other = (await preflight('https://evil.example')).headers.get('access-control-allow-origin');
      assert(other === null, `another origin was allowed (${other})`);
    },
  },
  {
    name: 'bound sessions: the app may send DPoP proofs and read the clock header',
    run: async () => {
      const preflight = await fetch(new URL('/v1/me', base), {
        method: 'OPTIONS',
        headers: { origin: 'https://gnomik.me', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,dpop' },
      });
      const allowed = preflight.headers.get('access-control-allow-headers') ?? '';
      assert(preflight.status === 204 && allowed.includes('dpop'), `preflight answered HTTP ${preflight.status} (${allowed})`);
      const res = await fetch(new URL('/v1/stats', base), { headers: { origin: 'https://gnomik.me' } });
      const exposed = res.headers.get('access-control-expose-headers') ?? '';
      assert(exposed.includes('dpop-time'), `DPoP-Time is not readable across origins (${exposed})`);
    },
  },
  {
    name: 'a token with a proof that does not hold is 401, not an error',
    run: async () => {
      const { status, body } = await api('/v1/me', { headers: { authorization: 'Bearer not.a.token', dpop: 'not.a.proof' } });
      assert(status === 401 && body?.error?.code === 'unauthenticated', `unexpected response ${status} ${JSON.stringify(body)}`);
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

// A freshly deployed Worker (especially a new preview hostname) can answer 404 for a few seconds, and a new Worker
// Preview's first Durable Object calls can fail while its storage is set up. So wait until it serves / and a party
// lookup (which reaches a Durable Object) answers 404, before checking anything.
const READY_TIMEOUT_MS = 60_000;
const startedAt = Date.now();
const ready = async () => {
  const home = await fetch(new URL('/', base)).then(res => res.status, () => 0);
  return home === 200 ? await fetch(new URL('/v1/parties?code=READYZZZ', base)).then(res => res.status, () => 0) : home;
};
while (true) {
  const status = await ready();
  if (status === 404) {
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
