import { DurableObject } from 'cloudflare:workers';

import { Env } from 'src/env';
import { newObjectId } from 'src/utils/ids';

import { HostingStart, UserPartyListItem, UserRecord, UserUpdate } from './types';

type UserRow = { id: string; email: string; name: string; joined: number };
type PartyRow = {
  slug: string;
  name: string;
  created_at: number;
  is_host: number | null;
  is_protected: number | null;
  is_closed: number | null;
  deleted_at: number | null;
};

const flag = (value: number | null) => (value === null ? null : Boolean(value));

/** How long a slot held for a party being created lasts if the party never arrives (say, the create failed). */
const HOST_RESERVATION_TTL_MS = 5 * 60 * 1000;

/**
 * One instance per user, addressed by the lowercased email (`env.USER.getByName(email)`).
 * Holds the profile and the user's party list. The list carries a summary of each party (name, host, protected,
 * closed), kept up to date by `PartyDO`'s outbox through `apply`, so listing parties needs no call to any party.
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
          created_at INTEGER NOT NULL,
          is_host INTEGER,
          is_protected INTEGER,
          is_closed INTEGER,
          deleted_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS host_reservations (
          id TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS used_magic_links (
          jti TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );
      `);
      // Lists created before party summaries existed get the columns added; their rows stay null until refreshed.
      const columns = new Set(this.sql.exec<{ name: string }>('PRAGMA table_info(parties)').toArray().map(c => c.name));
      for (const column of ['is_host', 'is_protected', 'is_closed', 'deleted_at']) {
        if (!columns.has(column)) {
          this.sql.exec(`ALTER TABLE parties ADD COLUMN ${column} INTEGER`);
        }
      }
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

  /**
   * Signs in with a magic link: returns the user (creating it on the first sign-in), or null when this link
   * was already used. Used links are kept only until they expire.
   */
  redeemMagicLink(email: string, jti: string, expiresAt: number): UserRecord | null {
    this.sql.exec('DELETE FROM used_magic_links WHERE expires_at < ?', Date.now());
    if (this.sql.exec('SELECT 1 FROM used_magic_links WHERE jti = ?', jti).toArray().length) {
      return null;
    }
    this.sql.exec('INSERT INTO used_magic_links (jti, expires_at) VALUES (?, ?)', jti, expiresAt);
    return this.ensure(email);
  }

  get(): UserRecord | null {
    return this.row();
  }

  /**
   * Checks the open-party limit and, when there is room, holds a slot for the party about to be created, in one step:
   * concurrent creates each see the slots the others hold. The slot is released when the new party lands in the list
   * (`releaseHostSlot`) or after HOST_RESERVATION_TTL_MS. Returns null when the user has no profile.
   */
  startHosting(limit: number): HostingStart | null {
    const user = this.row();
    if (!user) {
      return null;
    }
    const now = Date.now();
    this.sql.exec('DELETE FROM host_reservations WHERE expires_at < ?', now);
    const open = this.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM parties WHERE is_host = 1 AND NOT COALESCE(is_closed, 0) AND deleted_at IS NULL')
      .one().n;
    const held = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM host_reservations').one().n;
    if (open + held >= limit) {
      return { ...user, openHostedParties: open + held, allowed: false };
    }
    const reservation = newObjectId();
    this.sql.exec('INSERT INTO host_reservations (id, expires_at) VALUES (?, ?)', reservation, now + HOST_RESERVATION_TTL_MS);
    return { ...user, openHostedParties: open + held, allowed: true, reservation };
  }

  /** Applies a batch of changes from a party, in order, in one transaction. Safe to retry. */
  apply(updates: UserUpdate[]): void {
    this.ctx.storage.transactionSync(() => {
      for (const update of updates) {
        switch (update.type) {
          case 'addParty': {
            const { slug, name, createdAt, isHost, isProtected, isClosed, deletedAt = null } = update.party;
            this.sql.exec(
              'INSERT OR REPLACE INTO parties (slug, name, created_at, is_host, is_protected, is_closed, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
              slug, name, createdAt, Number(isHost), Number(isProtected), Number(isClosed), deletedAt,
            );
            break;
          }
          case 'removeParty':
            this.sql.exec('DELETE FROM parties WHERE slug = ?', update.slug);
            break;
          case 'setName':
            this.sql.exec('UPDATE user SET name = ?', update.name);
            break;
          case 'releaseHostSlot':
            this.sql.exec('DELETE FROM host_reservations WHERE id = ?', update.reservation);
            break;
        }
      }
    });
  }

  listParties(first: number): UserPartyListItem[] {
    return this.sql
      .exec<PartyRow>(
        'SELECT slug, name, created_at, is_host, is_protected, is_closed, deleted_at FROM parties ORDER BY created_at DESC LIMIT ?', first,
      )
      .toArray()
      .map(row => ({
        slug: row.slug,
        name: row.name,
        createdAt: row.created_at,
        isHost: flag(row.is_host),
        isProtected: flag(row.is_protected),
        isClosed: flag(row.is_closed),
        deletedAt: row.deleted_at,
      }));
  }
}
