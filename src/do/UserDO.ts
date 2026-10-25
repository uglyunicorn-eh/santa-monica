import { DurableObject } from 'cloudflare:workers';

import { Env } from 'src/env';
import { newObjectId } from 'src/utils/ids';
import { Session, sessionMatches } from 'src/utils/session';

import { PartyListCursor, UserPartyListItem, UserRecord, UserUpdate } from './types';

type UserRow = { id: string; email: string; name: string; joined: number; token_version: number; deleted_at: number | null };
type PartyRow = {
  slug: string;
  name: string;
  created_at: number;
  is_host: number | null;
  is_protected: number | null;
  is_closed: number | null;
};

const flag = (value: number | null) => (value === null ? null : Boolean(value));

const toRecord = ({ id, email, name, joined, token_version }: UserRow): UserRecord =>
  ({ id, email, name, joined, tokenVersion: token_version });

// Columns added after the first release. Tables created before them get the columns on the next start.
const ADDED_COLUMNS: Record<string, Record<string, string>> = {
  user: {
    token_version: 'INTEGER NOT NULL DEFAULT 0',
    deleted_at: 'INTEGER',
  },
  parties: {
    is_host: 'INTEGER',
    is_protected: 'INTEGER',
    is_closed: 'INTEGER',
  },
};

/**
 * One instance per user, addressed by the lowercased email (`env.USER.getByName(email)`).
 * Holds the profile and the user's party list. The list carries a summary of each party (name, host, protected,
 * closed), kept up to date by `PartyDO`'s outbox through `apply`, so listing parties needs no call to any party.
 *
 * A deleted account leaves a tombstone: `get()` returns null and `apply` writes nothing, so late outbox deliveries
 * can't bring the record back, and the token version is bumped so its session tokens stop working. The next sign-in
 * with the same email starts a new account (new id) on top of it.
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
          joined INTEGER NOT NULL,
          token_version INTEGER NOT NULL DEFAULT 0,
          deleted_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS parties (
          slug TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          is_host INTEGER,
          is_protected INTEGER,
          is_closed INTEGER
        );
        CREATE TABLE IF NOT EXISTS used_magic_links (
          jti TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );
      `);
      // Party rows stored before summaries existed stay null until refreshed; users get version 0, not deleted.
      for (const [table, added] of Object.entries(ADDED_COLUMNS)) {
        const columns = new Set(this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map(c => c.name));
        for (const [column, definition] of Object.entries(added)) {
          if (!columns.has(column)) {
            this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
          }
        }
      }
    });
  }

  private row(): UserRow | null {
    return this.sql.exec<UserRow>('SELECT id, email, name, joined, token_version, deleted_at FROM user LIMIT 1').toArray()[0] ?? null;
  }

  /** Returns the user, creating it on the first sign-in, or starting a new account after a deleted one. */
  ensure(email: string): UserRecord {
    const existing = this.row();
    if (existing && existing.deleted_at === null) {
      return toRecord(existing);
    }
    // After a deleted account, the tombstone's token version is kept, so the old account's tokens stay revoked.
    const row: UserRow = {
      id: newObjectId(), email, name: '', joined: Date.now(), token_version: existing?.token_version ?? 0, deleted_at: null,
    };
    this.sql.exec('DELETE FROM user');
    this.sql.exec(
      'INSERT INTO user (id, email, name, joined, token_version) VALUES (?, ?, ?, ?, ?)',
      row.id, row.email, row.name, row.joined, row.token_version,
    );
    return toRecord(row);
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

  /** The user, or null when there is none or the account was deleted. */
  get(): UserRecord | null {
    const row = this.row();
    return row && row.deleted_at === null ? toRecord(row) : null;
  }

  /**
   * Sets the profile name, the default name for parties the user joins later. Parties already joined keep the
   * name the user joined them with. Returns null, changing nothing, when the session no longer belongs to this user.
   */
  updateName(name: string, session: Session): UserRecord | null {
    const user = this.get();
    if (!sessionMatches(user, session)) {
      return null;
    }
    this.sql.exec('UPDATE user SET name = ?', name);
    return { ...user!, name };
  }

  /**
   * Deletes the account, leaving a tombstone: the profile and party list are wiped, and every session token issued
   * so far is revoked. An object without a user yet gets a tombstone too, so nothing can be written to it.
   */
  tombstone(): void {
    this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      if (this.row()) {
        this.sql.exec("UPDATE user SET name = '', deleted_at = ?, token_version = token_version + 1", now);
      } else {
        this.sql.exec("INSERT INTO user (id, email, name, joined, token_version, deleted_at) VALUES (?, '', '', ?, 1, ?)", newObjectId(), now, now);
      }
      this.sql.exec('DELETE FROM parties');
    });
  }

  /**
   * Applies a batch of changes from a party, in order, in one transaction. Safe to retry.
   * Writes nothing to a deleted account, and nothing when `session` is given and no longer belongs to this user, so a
   * party can verify a joining session in the call it makes anyway. Returns the user as it is afterwards (null if
   * there is none or it was deleted).
   */
  apply(updates: UserUpdate[], session?: Session): UserRecord | null {
    const row = this.row();
    if (row?.deleted_at) {
      return null;
    }
    const user = row && toRecord(row);
    if (session && !sessionMatches(user, session)) {
      return user;
    }
    let name = user?.name;
    this.ctx.storage.transactionSync(() => {
      for (const update of updates) {
        switch (update.type) {
          case 'addParty': {
            const { slug, name, createdAt, isHost, isProtected, isClosed } = update.party;
            this.sql.exec(
              'INSERT OR REPLACE INTO parties (slug, name, created_at, is_host, is_protected, is_closed) VALUES (?, ?, ?, ?, ?, ?)',
              slug, name, createdAt, Number(isHost), Number(isProtected), Number(isClosed),
            );
            break;
          }
          case 'removeParty':
            this.sql.exec('DELETE FROM parties WHERE slug = ?', update.slug);
            break;
          case 'setName':
            name = update.name;
            this.sql.exec('UPDATE user SET name = ?', name);
            break;
          case 'setNameIfEmpty':
            // Only the account that joined: a join checked late (by the alarm) must not name a newer account.
            if (user && name === '' && (update.userId ?? user.id) === user.id) {
              name = update.name;
              this.sql.exec('UPDATE user SET name = ?', name);
            }
            break;
        }
      }
    });
    return user && { ...user, name: name! };
  }

  /**
   * The user's parties, newest first. Parties created at the same time are ordered by slug, so `after` (the last
   * row of the previous page) continues exactly where that page ended.
   */
  listParties(first: number, after?: PartyListCursor | null): UserPartyListItem[] {
    const columns = 'slug, name, created_at, is_host, is_protected, is_closed';
    const order = 'ORDER BY created_at DESC, slug DESC LIMIT ?';
    const rows = after
      ? this.sql.exec<PartyRow>(
        `SELECT ${columns} FROM parties WHERE created_at < ? OR (created_at = ? AND slug < ?) ${order}`,
        after.createdAt, after.createdAt, after.slug, first,
      )
      : this.sql.exec<PartyRow>(`SELECT ${columns} FROM parties ${order}`, first);
    return rows
      .toArray()
      .map(row => ({
        slug: row.slug,
        name: row.name,
        createdAt: row.created_at,
        isHost: flag(row.is_host),
        isProtected: flag(row.is_protected),
        isClosed: flag(row.is_closed),
      }));
  }
}
