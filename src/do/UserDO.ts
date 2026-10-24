import { DurableObject } from 'cloudflare:workers';

import { Env } from 'src/env';
import { newObjectId } from 'src/utils/ids';

import { UserPartyRecord, UserRecord, UserSnapshot } from './types';

type UserRow = { id: string; email: string; name: string; joined: number };
type PartyRow = { slug: string; name: string; created_at: number };

/**
 * One instance per user, addressed by the lowercased email (`env.USER.getByName(email)`).
 * Holds the profile and the user's party list. The party list is a copy kept up to date by `PartyDO`'s outbox,
 * so every method that `PartyDO` calls is idempotent.
 */
export class UserDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS user (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          joined INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS parties (
          slug TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
    });
  }

  private row(): UserRow | null {
    return this.sql.exec<UserRow>('SELECT id, email, name, joined FROM user LIMIT 1').toArray()[0] ?? null;
  }

  /** Returns the user, creating it on the first sign-in. */
  ensure(email: string): UserRecord {
    const existing = this.row();
    if (existing) {
      return existing;
    }
    const user = { id: newObjectId(), email, name: '', joined: Date.now() };
    this.sql.exec('INSERT INTO user (id, email, name, joined) VALUES (?, ?, ?, ?)', user.id, user.email, user.name, user.joined);
    return user;
  }

  get(): UserRecord | null {
    return this.row();
  }

  setName(name: string): void {
    this.sql.exec('UPDATE user SET name = ?', name);
  }

  addParty(party: UserPartyRecord): void {
    this.sql.exec(
      'INSERT OR REPLACE INTO parties (slug, name, created_at) VALUES (?, ?, ?)',
      party.slug, party.name, party.createdAt,
    );
  }

  removeParty(slug: string): void {
    this.sql.exec('DELETE FROM parties WHERE slug = ?', slug);
  }

  listParties(first: number): UserPartyRecord[] {
    return this.sql
      .exec<PartyRow>('SELECT slug, name, created_at FROM parties ORDER BY created_at DESC LIMIT ?', first)
      .toArray()
      .map(({ slug, name, created_at }) => ({ slug, name, createdAt: created_at }));
  }

  /** Replaces the whole user with the snapshot. Used by the Mongo import, safe to re-run. */
  importUser(snapshot: UserSnapshot): { parties: number } {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM user');
      this.sql.exec('DELETE FROM parties');
      this.sql.exec(
        'INSERT INTO user (id, email, name, joined) VALUES (?, ?, ?, ?)',
        snapshot.id, snapshot.email, snapshot.name, snapshot.joined,
      );
      for (const party of snapshot.parties) {
        this.addParty(party);
      }
    });
    return { parties: snapshot.parties.length };
  }
}
