// Sends data/snapshot.json to the Worker's temporary import endpoint and compares the counts.
// Usage: IMPORT_URL=https://gnomik-api.<account>.workers.dev ADMIN_SECRET=... npm run import
import fs from 'node:fs';
import path from 'node:path';

import type { ImportSnapshot } from '../src/do/types.ts';

const url = process.env.IMPORT_URL;
const secret = process.env.ADMIN_SECRET;
const file = path.resolve(process.argv[2] ?? 'data/snapshot.json');

if (!url || !secret) {
  console.error('Set IMPORT_URL and ADMIN_SECRET.');
  process.exit(1);
}

const snapshot = JSON.parse(fs.readFileSync(file, 'utf8')) as ImportSnapshot & { counts: Record<string, number> };

const res = await fetch(new URL('/admin/import', url), {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-admin-secret': secret },
  body: JSON.stringify({ users: snapshot.users, parties: snapshot.parties }),
});

if (!res.ok) {
  console.error(`Import failed: HTTP ${res.status}`, await res.text());
  process.exit(1);
}

const { imported } = await res.json() as { imported: Record<string, number> };
const expected = snapshot.counts;

let ok = true;
for (const key of ['users', 'userParties', 'parties', 'memberships']) {
  const match = imported[key] === expected[key];
  ok &&= match;
  console.log(`${match ? 'ok ' : 'MISMATCH'} ${key}: expected ${expected[key]}, imported ${imported[key]}`);
}
process.exitCode = ok ? 0 : 1;
