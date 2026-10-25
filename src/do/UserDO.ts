import { DurableObject } from 'cloudflare:workers';

import { Env } from 'src/env';
import { newObjectId } from 'src/utils/ids';
import { Session, sessionMatches } from 'src/utils/session';

import { HostingStart, PartyListCursor, UserPartyListItem, UserPartyRecord, UserRecord, UserUpdate } from './types';

type UserRow = {
  id: string;
  email: string;
  name: string;
  joined: number;
  token_version: number;
  deleted_at: number | null;
  /** Set while the account is being deleted or moved to another email (see `startAccountChange`). */
  changing_until?: number | null;
};

/** How long an account change holds the account at most, in case the request running it never finishes. */
const ACCOUNT_CHANGE_MS = 60 * 1000;

const isChanging = (row: UserRow) => Boolean(row.changing_until && row.changing_until > Date.now());
type PartyRow = {
  slug: string;
  name: string;
  created_at: number;
  is_host: number | null;
  is_protected: number | null;
  is_closed: number | null;
  closed_at: number | null;
  deleted_at: number | null;
};

const flag = (value: number | null) => (value === null ? null : Boolean(value));

const toRecord = ({ id, email, name, joined, token_version }: UserRow): UserRecord =>
  ({ id, email, name, joined, tokenVersion: token_version });

// Columns added after the first release. Tables created before them get the columns on the next start.
const ADDED_COLUMNS: Record<string, Record<string, string>> = {
  user: {
    token_version: 'INTEGER NOT NULL DEFAULT 0',
    deleted_at: 'INTEGER',
    changing_until: 'INTEGER',
  },
  parties: {
    is_host: 'INTEGER',
    is_protected: 'INTEGER',
    is_closed: 'INTEGER',
    closed_at: 'INTEGER',
    deleted_at: 'INTEGER',
  },
  // What a create request was for (the party name): the same key with another name is a new request.
  create_requests: {
    detail: 'TEXT',
  },
  // The hashed Idempotency-Key a link was used with, and what it did (the new email, for an email change), so that
  // repeating the same request answers the same; anyone else gets "already used".
  used_magic_links: {
    request_key: 'TEXT',
    outcome: 'TEXT',
  },
};

/** How long a slot held for a party being created lasts if the party never arrives (say, the create failed). */
const HOST_RESERVATION_TTL_MS = 5 * 60 * 1000;
/** How long a repeated createParty request with the same request id returns the party the first one created. */
const CREATE_REQUEST_TTL_MS = 10 * 60 * 1000;
/** How long a repeated account email request (deletion, email change) with the same request id sends nothing again. */
const MAIL_REQUEST_TTL_MS = 10 * 60 * 1000;

/**
 * One instance per user, addressed by the normalized email (`canonicalEmail`, `env.USER.getByName(email)`). Accounts
 * made before addresses were normalized are kept under the address as typed, lowercased, until their next sign-in.
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
          deleted_at INTEGER,
          changing_until INTEGER
        );
        CREATE TABLE IF NOT EXISTS parties (
          slug TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          is_host INTEGER,
          is_protected INTEGER,
          is_closed INTEGER,
          closed_at INTEGER,
          deleted_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS host_reservations (
          id TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS create_requests (
          key TEXT PRIMARY KEY,
          party_id TEXT NOT NULL,
          slug TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          detail TEXT
        );
        CREATE TABLE IF NOT EXISTS mail_requests (
          key TEXT PRIMARY KEY,
          detail TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS used_magic_links (
          jti TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL,
          request_key TEXT,
          outcome TEXT
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
    return this.sql.exec<UserRow>('SELECT id, email, name, joined, token_version, deleted_at, changing_until FROM user LIMIT 1').toArray()[0] ?? null;
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
   * was already used. A repeat of the request that used it (same `requestKey`) gets the user again. Used links are
   * kept only until they expire.
   */
  redeemMagicLink(email: string, jti: string, expiresAt: number, requestKey?: string): UserRecord | null {
    const used = this.usedLink(jti);
    if (used) {
      return requestKey && used.request_key === requestKey ? this.get() : null;
    }
    this.sql.exec('INSERT INTO used_magic_links (jti, expires_at, request_key) VALUES (?, ?, ?)', jti, expiresAt, requestKey ?? null);
    return this.ensure(email);
  }

  /** How an emailed link was used, or null if it wasn't (forgetting used links that have expired). */
  private usedLink(jti: string): { request_key: string | null; outcome: string | null } | null {
    this.sql.exec('DELETE FROM used_magic_links WHERE expires_at < ?', Date.now());
    return this.sql
      .exec<{ request_key: string | null; outcome: string | null }>('SELECT request_key, outcome FROM used_magic_links WHERE jti = ?', jti)
      .toArray()[0] ?? null;
  }

  /**
   * Starts deleting the account or moving it to another email, from an emailed link: checks the link is for this
   * account (`userId`) and not used yet, marks it used, and returns the user with the slugs of all their parties.
   * Until the change finishes (the account is tombstoned), is aborted, or a minute passes, the account is held: it
   * reads as missing, refuses joins and profile changes, and no other change can start, so the party list can't
   * change under the one running.
   */
  startAccountChange(userId: string, jti: string, expiresAt: number, request?: { key?: string; outcome?: string }):
    | { ok: true; user: UserRecord; parties: string[] }
    | { ok: false; reason: 'gone' | 'used' | 'busy' }
    | { ok: false; reason: 'repeat'; outcome: string | null } {
    // A used link is reported as used even when the change it made left this account a tombstone, unless this is a
    // repeat of the request that used it.
    const used = this.usedLink(jti);
    if (used) {
      return request?.key && used.request_key === request.key
        ? { ok: false, reason: 'repeat', outcome: used.outcome }
        : { ok: false, reason: 'used' };
    }
    const row = this.row();
    if (!row || row.deleted_at !== null || row.id !== userId) {
      return { ok: false, reason: 'gone' };
    }
    if (isChanging(row)) {
      return { ok: false, reason: 'busy' };
    }
    this.sql.exec(
      'INSERT INTO used_magic_links (jti, expires_at, request_key, outcome) VALUES (?, ?, ?, ?)',
      jti, expiresAt, request?.key ?? null, request?.outcome ?? null,
    );
    this.sql.exec('UPDATE user SET changing_until = ?', Date.now() + ACCOUNT_CHANGE_MS);
    const parties = this.sql.exec<{ slug: string }>('SELECT slug FROM parties').toArray().map(r => r.slug);
    return { ok: true, user: toRecord(row), parties };
  }

  /** Releases an account change that could not finish, and the link that started it, so the link can be tried again. */
  abortAccountChange(jti: string): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('UPDATE user SET changing_until = NULL');
      this.sql.exec('DELETE FROM used_magic_links WHERE jti = ?', jti);
    });
  }

  /**
   * Receives an account moved here from another email: the same user (id, name, joined, token version) and their
   * party list. Refused (null) when a live account already uses this email. Party rows already here are newer (the
   * parties have been sending to this email since they were moved), so they are kept.
   */
  receive(user: UserRecord, parties: UserPartyRecord[]): UserRecord | null {
    const existing = this.row();
    if (existing && existing.deleted_at === null) {
      return null;
    }
    // Never go below a version this email's object already handed out.
    const row: UserRow = { ...user, token_version: Math.max(user.tokenVersion, existing?.token_version ?? 0), deleted_at: null };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM user');
      this.sql.exec(
        'INSERT INTO user (id, email, name, joined, token_version) VALUES (?, ?, ?, ?, ?)',
        row.id, row.email, row.name, row.joined, row.token_version,
      );
      for (const party of parties) {
        this.putParty(party, 'INSERT OR IGNORE');
      }
    });
    return toRecord(row);
  }

  private putParty(
    { slug, name, createdAt, isHost, isProtected, isClosed, closedAt, deletedAt = null }: UserPartyRecord,
    insert: 'INSERT OR REPLACE' | 'INSERT OR IGNORE',
  ) {
    this.sql.exec(
      `${insert} INTO parties (slug, name, created_at, is_host, is_protected, is_closed, closed_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      slug, name, createdAt, Number(isHost), Number(isProtected), Number(isClosed), closedAt, deletedAt,
    );
  }

  /** The user, or null when there is none, the account was deleted, or it is being deleted or moved right now. */
  get(): UserRecord | null {
    const row = this.row();
    return row && row.deleted_at === null && !isChanging(row) ? toRecord(row) : null;
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
   * Checks the open-party limit and, when there is room, holds a slot for the party about to be created, in one step:
   * concurrent creates each see the slots the others hold. The slot is released when the new party lands in the list
   * (`releaseHostSlot`) or after HOST_RESERVATION_TTL_MS. Returns null when there is no user or the session no longer
   * belongs to them.
   */
  startHosting(limit: number, session: Session, request?: { key: string; id: string; slug: string; detail?: string }): HostingStart | null {
    const user = this.get();
    if (!sessionMatches(user, session)) {
      return null;
    }
    const now = Date.now();
    this.sql.exec('DELETE FROM host_reservations WHERE expires_at < ?', now);
    this.sql.exec('DELETE FROM create_requests WHERE expires_at < ?', now);
    const open = this.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM parties WHERE is_host = 1 AND NOT COALESCE(is_closed, 0) AND deleted_at IS NULL')
      .one().n;
    const held = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM host_reservations').one().n;
    const previous = request && this.sql
      .exec<{ party_id: string; slug: string; detail: string | null }>('SELECT party_id, slug, detail FROM create_requests WHERE key = ?', request.key)
      .toArray()[0];
    // The same key for a different party (another name) is a new request: it replaces the old one below.
    const repeated = previous && (previous.detail ?? undefined) === request.detail ? previous : undefined;
    if (repeated) {
      // The same request again: it holds no new slot, and gets the party the first one made (or is making).
      return { ...user!, openHostedParties: open + held, allowed: true, request: { id: repeated.party_id, slug: repeated.slug } };
    }
    if (open + held >= limit) {
      return { ...user!, openHostedParties: open + held, allowed: false };
    }
    const reservation = newObjectId();
    this.sql.exec('INSERT INTO host_reservations (id, expires_at) VALUES (?, ?)', reservation, now + HOST_RESERVATION_TTL_MS);
    if (request) {
      this.sql.exec(
        'INSERT OR REPLACE INTO create_requests (key, party_id, slug, expires_at, detail) VALUES (?, ?, ?, ?, ?)',
        request.key, request.id, request.slug, now + CREATE_REQUEST_TTL_MS, request.detail ?? null,
      );
    }
    return { ...user!, openHostedParties: open + held, allowed: true, reservation, request: request && { id: request.id, slug: request.slug } };
  }

  /** Points a create request at another party code, when the one it first took turned out to be in use. */
  retargetRequest(key: string, slug: string): void {
    this.sql.exec('UPDATE create_requests SET slug = ? WHERE key = ?', slug, key);
  }

  /**
   * Claims an account email request by its request id. Returns false when the same request (same key and detail) was
   * claimed in the last MAIL_REQUEST_TTL_MS, so the caller answers it without emailing again. The same key with another
   * detail (say, a different new address) is a new request and replaces the old claim.
   */
  claimMailRequest(key: string, detail: string): boolean {
    const now = Date.now();
    this.sql.exec('DELETE FROM mail_requests WHERE expires_at < ?', now);
    const claimed = this.sql.exec<{ detail: string }>('SELECT detail FROM mail_requests WHERE key = ?', key).toArray()[0];
    if (claimed?.detail === detail) {
      return false;
    }
    this.sql.exec('INSERT OR REPLACE INTO mail_requests (key, detail, expires_at) VALUES (?, ?, ?)', key, detail, now + MAIL_REQUEST_TTL_MS);
    return true;
  }

  /** Frees a claimed request whose email didn't go out, so a retry of it sends one. */
  releaseMailRequest(key: string, detail: string): void {
    this.sql.exec('DELETE FROM mail_requests WHERE key = ? AND detail = ?', key, detail);
  }

  /**
   * Whether this request (same key and detail) was already claimed and is still remembered. Only reads: requests
   * without a session look first, run the rate limits, and claim only then, so nobody can fill this table for free.
   */
  seenMailRequest(key: string, detail: string): boolean {
    return this.sql
      .exec('SELECT 1 FROM mail_requests WHERE key = ? AND detail = ? AND expires_at >= ?', key, detail, Date.now())
      .toArray().length > 0;
  }

  /**
   * Starts an account email request from a signed-in user, in one call: checks the session, then claims the request
   * id when there is one. Returns the user, `'repeat'` for a request already claimed, or null when the session no
   * longer belongs to this user.
   */
  beginMailRequest(session: Session, key: string | undefined, detail: string): UserRecord | 'repeat' | null {
    const user = this.get();
    if (!sessionMatches(user, session)) {
      return null;
    }
    if (key && !this.claimMailRequest(key, detail)) {
      return 'repeat';
    }
    return user;
  }

  /**
   * Applies a batch of changes from a party, in order, in one transaction. Safe to retry.
   * Writes nothing to a deleted account, and nothing when `session` is given and no longer belongs to this user (or
   * the account is held by an account change), so a party can verify a joining session in the call it makes anyway. Returns the user as it is afterwards (null if
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
    if (session && isChanging(row!)) {
      // Held by an account change: a join now would be missed by it.
      return null;
    }
    let name = user?.name;
    this.ctx.storage.transactionSync(() => {
      for (const update of updates) {
        switch (update.type) {
          case 'addParty':
            this.putParty(update.party, 'INSERT OR REPLACE');
            break;
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
          case 'releaseHostSlot':
            this.sql.exec('DELETE FROM host_reservations WHERE id = ?', update.reservation);
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
  listParties(first: number, after?: PartyListCursor | null, session?: Session): UserPartyListItem[] | null {
    // With a session, the list is only for the account the session belongs to (not a newer one on the same email).
    if (session && !sessionMatches(this.get(), session)) {
      return null;
    }
    const columns = 'slug, name, created_at, is_host, is_protected, is_closed, closed_at, deleted_at';
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
        closedAt: row.closed_at,
        deletedAt: row.deleted_at,
      }));
  }
}
