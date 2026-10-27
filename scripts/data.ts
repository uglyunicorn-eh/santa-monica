// One-off maintenance of the stored data, through the Cloudflare API's Durable Object SQL endpoint (the one Data
// Studio uses). Objects tidy themselves when they next start; this reaches the ones nobody opens any more.
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/data.ts count          # drawn parties
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/data.ts tidy           # what tidy would change
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/data.ts tidy --apply   # change it
//
// The token needs Workers Scripts Write (the SQL endpoint asks for it even to read). WORKER defaults to gnomik-api
// (production). Reads only ever select flags and counts; nothing personal leaves Cloudflare.

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const worker = process.env.WORKER ?? 'gnomik-api';
const [command, flag] = process.argv.slice(2);
const apply = flag === '--apply';

if (!token || !account || !['count', 'tidy'].includes(command)) {
  console.error('Usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/data.ts count|tidy [--apply]');
  process.exit(1);
}

type Result = { columns: string[]; rows: unknown[][] };

async function cf<T>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<{ result: T; result_info?: { cursor?: string } }> {
  const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`);
  for (const [name, value] of Object.entries(init.query ?? {})) {
    url.searchParams.set(name, value);
  }
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = await res.json() as any;
  if (!res.ok || json.success === false) {
    throw new Error(`${init.method ?? 'GET'} ${path}: HTTP ${res.status} ${JSON.stringify(json.errors ?? json)}`);
  }
  // The SQL endpoint answers with { results } at the top level; the others wrap it in { result }.
  return json.result !== undefined ? json : { result: json };
}

/** The ids of every object of `className` that holds data. */
async function objects(className: string): Promise<{ namespace: string; ids: string[] }> {
  const { result: namespaces } = await cf<{ id: string; script: string; class: string }[]>('/workers/durable_objects/namespaces', { query: { per_page: '100' } });
  const namespace = namespaces.find(ns => ns.script === worker && ns.class === className);
  if (!namespace) {
    throw new Error(`No ${className} namespace for ${worker}`);
  }
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await cf<{ id: string; hasStoredData: boolean }[]>(`/workers/durable_objects/namespaces/${namespace.id}/objects`, {
      query: { limit: '1000', ...(cursor ? { cursor } : {}) },
    });
    ids.push(...page.result.filter(o => o.hasStoredData).map(o => o.id));
    cursor = page.result_info?.cursor || undefined;
  } while (cursor);
  return { namespace: namespace.id, ids };
}

/** Runs SQL in one object. Each statement is `[sql, ...params]`. */
async function sql(namespace: string, id: string, ...queries: [string, ...(string | number)[]][]): Promise<Result[]> {
  const { result } = await cf<{ results: Result[]; error?: string }>(`/workers/durable_objects/namespaces/${namespace}/query/v2`, {
    method: 'POST',
    body: { durable_object_id: id, queries: queries.map(([text, ...params]) => ({ sql: text, params })) },
  });
  if (result.error) {
    throw new Error(`${id}: ${result.error}`);
  }
  return result.results;
}

const first = (result: Result) => result.rows[0]?.[0];

async function tables(namespace: string, id: string): Promise<Set<string>> {
  const [result] = await sql(namespace, id, ["SELECT name FROM sqlite_master WHERE type = 'table'"]);
  return new Set(result.rows.map(row => String(row[0])));
}

/** Drawn parties, for the Party'o'meter's starting value (ROLLED_BEFORE_COUNTER in src/do/StatsDO.ts). */
async function count() {
  const { namespace, ids } = await objects('PartyDO');
  let drawn = 0;
  for (const id of ids) {
    if ((await tables(namespace, id)).has('party')) {
      const [result] = await sql(namespace, id, ['SELECT COUNT(*) FROM party WHERE is_closed = 1']);
      drawn += Number(first(result));
    }
  }
  console.log(`${worker}: ${drawn} drawn parties (${ids.length} party objects with data)`);
}

/**
 * Does what the objects' own clean-up does (PartyDO.tidy, UserDO.tombstone and forgetExpired), for objects that won't
 * start again on their own. Open parties are left alone: their invites move to the new counter when they next start,
 * and deleting invites before that would lose count of them.
 */
async function tidy() {
  const changes: string[] = [];
  const parties = await objects('PartyDO');
  for (const id of parties.ids) {
    const has = await tables(parties.namespace, id);
    if (!has.has('party')) {
      continue;
    }
    const [closed] = await sql(parties.namespace, id, ['SELECT is_closed FROM party']);
    if (!first(closed)) {
      continue;
    }
    const [invites, emails, queued] = await sql(parties.namespace, id,
      [has.has('invites') ? 'SELECT COUNT(*) FROM invites' : 'SELECT 0'],
      ['SELECT COUNT(*) FROM memberships WHERE member_email IS NOT NULL'],
      [has.has('outbox') ? 'SELECT COUNT(*) FROM outbox' : 'SELECT 0']);
    const statements: [string][] = [];
    if (Number(first(invites))) {
      statements.push(['DELETE FROM invites']);
    }
    if (Number(first(emails)) && !Number(first(queued))) {
      statements.push(['UPDATE memberships SET member_email = NULL WHERE member_email IS NOT NULL']);
    }
    if (statements.length) {
      changes.push(`party ${id}: ${first(invites)} invites, ${first(emails)} member emails`);
      if (apply) {
        await sql(parties.namespace, id, ...statements);
      }
    }
  }

  const users = await objects('UserDO');
  const now = Date.now();
  const expiring = ['used_magic_links', 'mail_requests', 'create_requests', 'host_reservations'];
  for (const id of users.ids) {
    const has = await tables(users.namespace, id);
    if (!has.has('user')) {
      continue;
    }
    const present = expiring.filter(table => has.has(table));
    const [tombstone, ...expired] = await sql(users.namespace, id,
      ["SELECT COUNT(*) FROM user WHERE deleted_at IS NOT NULL AND email != ''"],
      ...present.map((table): [string, number] => [`SELECT COUNT(*) FROM ${table} WHERE expires_at < ?`, now]));
    const statements: [string, ...number[]][] = [];
    if (Number(first(tombstone))) {
      statements.push(["UPDATE user SET email = '' WHERE deleted_at IS NOT NULL"]);
    }
    present.forEach((table, i) => {
      if (Number(first(expired[i]))) {
        statements.push([`DELETE FROM ${table} WHERE expires_at < ?`, now]);
      }
    });
    if (statements.length) {
      changes.push(`user ${id}: ${statements.length} change(s)`);
      if (apply) {
        await sql(users.namespace, id, ...statements);
      }
    }
  }

  console.log(changes.length ? changes.join('\n') : 'Nothing to tidy.');
  console.log(apply ? `Applied ${changes.length} change(s).` : `${changes.length} object(s) to change. Run again with --apply to change them.`);
}

await (command === 'count' ? count() : tidy());
