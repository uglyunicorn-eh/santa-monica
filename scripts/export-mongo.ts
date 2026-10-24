// Exports the Mongo data into the snapshot format the Worker's import endpoint expects.
// Usage: npm run export-mongo   (reads MONGODB_URI from .env.local, writes data/snapshot.json)
import fs from 'node:fs';
import path from 'node:path';

import { MongoClient, ObjectId } from 'mongodb';

import type { PartySnapshot, UserSnapshot } from '../src/do/types.ts';

type MongoUser = { _id: ObjectId; name?: string; email?: string; joined?: Date };
type MongoParty = { _id: ObjectId; host: ObjectId; name: string; password: string | null; slug: string; isClosed?: boolean };
type MongoMembership = { _id: ObjectId; party: ObjectId; member: ObjectId; name: string; target?: { member?: ObjectId; user?: ObjectId; name: string } };

const mask = (s: unknown) => String(s).replace(/mongodb(\+srv)?:\/\/[^\s"]*/g, 'mongodb://***');

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB ?? 'adm';
const out = path.resolve(process.argv[2] ?? 'data/snapshot.json');

if (!uri) {
  console.error('MONGODB_URI is not set (expected in .env.local).');
  process.exit(1);
}

let client: MongoClient | undefined;
try {
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const db = client.db(dbName);

  const users = await db.collection<MongoUser>('User').find().toArray();
  const parties = await db.collection<MongoParty>('Party').find().toArray();
  const memberships = await db.collection<MongoMembership>('PartyMembership').find().toArray();

  const userById = new Map(users.map(u => [u._id.toHexString(), u]));
  const partyById = new Map(parties.map(p => [p._id.toHexString(), p]));
  const emailOf = (id: ObjectId) => userById.get(id.toHexString())?.email?.toLowerCase() ?? null;

  const snapshotParties: PartySnapshot[] = parties.map(p => ({
    id: p._id.toHexString(),
    slug: p.slug.toUpperCase(),
    name: p.name,
    password: p.password || null,
    hostId: p.host.toHexString(),
    isClosed: Boolean(p.isClosed),
    createdAt: p._id.getTimestamp().getTime(),
    members: memberships
      .filter(m => m.party.equals(p._id))
      .map(m => {
        // Stored targets use { member, name }; older code expected { user, name }.
        const targetId = m.target?.member ?? m.target?.user ?? null;
        return {
          id: m.member.toHexString(),
          email: emailOf(m.member),
          name: m.name,
          targetId: targetId ? targetId.toHexString() : null,
          targetName: m.target?.name ?? null,
          joinedAt: m._id.getTimestamp().getTime(),
        };
      }),
  }));

  // Users without an email (old Facebook logins) can't sign in, so they get no UserDO. Their memberships are kept.
  const snapshotUsers: UserSnapshot[] = users
    .filter(u => u.email)
    .map(u => ({
      id: u._id.toHexString(),
      email: u.email!.toLowerCase(),
      name: u.name ?? '',
      joined: (u.joined ?? u._id.getTimestamp()).getTime(),
      parties: memberships
        .filter(m => m.member.equals(u._id) && partyById.has(m.party.toHexString()))
        .map(m => {
          const p = partyById.get(m.party.toHexString())!;
          return { slug: p.slug.toUpperCase(), name: p.name, createdAt: p._id.getTimestamp().getTime() };
        }),
    }));

  const emails = snapshotUsers.map(u => u.email);
  if (new Set(emails).size !== emails.length) {
    throw new Error('Duplicate emails in User collection. Resolve them before importing.');
  }
  const slugs = snapshotParties.map(p => p.slug);
  if (new Set(slugs).size !== slugs.length) {
    throw new Error('Duplicate party slugs. Resolve them before importing.');
  }

  const snapshot = {
    exportedAt: new Date().toISOString(),
    counts: {
      users: snapshotUsers.length,
      legacyUsers: users.length - snapshotUsers.length,
      userParties: snapshotUsers.reduce((n, u) => n + u.parties.length, 0),
      parties: snapshotParties.length,
      memberships: snapshotParties.reduce((n, p) => n + p.members.length, 0),
    },
    users: snapshotUsers,
    parties: snapshotParties,
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2));
  console.log(`Wrote ${out}`);
  console.log(snapshot.counts);
} catch (error) {
  console.error('Export failed:', mask(error instanceof Error ? error.message : error));
  process.exitCode = 1;
} finally {
  await client?.close();
}
