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

// The frontend calls /graph/ (with the slash), so the smoke test does too.
const gql = async (query: string, variables: Record<string, unknown> = {}) => {
  const res = await fetch(new URL('/graph/', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  assert(res.ok, `/graph answered HTTP ${res.status}`);
  return await res.json() as { data?: any; errors?: unknown[] };
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
    name: 'GraphQL app query',
    run: async () => {
      const { data, errors } = await gql('{ app { name version } }');
      assert(!errors && data?.app?.name === 'santa-monica', `unexpected response ${JSON.stringify({ data, errors })}`);
    },
  },
  {
    name: 'unknown party is null',
    run: async () => {
      const { data, errors } = await gql('query ($code: String!) { party(code: $code) { id } }', { code: 'QQQQQ' });
      assert(!errors && data?.party === null, `unexpected response ${JSON.stringify({ data, errors })}`);
    },
  },
  {
    name: 'anonymous user is null',
    run: async () => {
      const { data, errors } = await gql('{ user { id } }');
      assert(!errors && data?.user === null, `unexpected response ${JSON.stringify({ data, errors })}`);
    },
  },
  {
    name: 'CORS preflight',
    run: async () => {
      const res = await fetch(new URL('/graph', base), {
        method: 'OPTIONS',
        headers: { origin: 'https://gnomik.me', 'access-control-request-method': 'POST' },
      });
      assert(res.status === 204 && res.headers.get('access-control-allow-origin') === '*', `preflight answered HTTP ${res.status}`);
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
