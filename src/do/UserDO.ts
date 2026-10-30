import { DurableObject } from 'cloudflare:workers';

import { Env } from 'src/env';
import { renderAccountDeleted, sendMail } from 'src/mail';
import { newObjectId } from 'src/utils/ids';
import { Session, sessionMatches } from 'src/utils/session';

import { LIVE_USER_HEADER, LIVE_VERSION_HEADER } from 'src/utils/liveHeaders';
import { Outbox } from './outbox';
import { HostingStart, PartyCounts, PartyListCursor, UserPartyListItem, UserPartyRecord, UserProfile, UserRecord, UserUpdate } from './types';

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

/** Mail the account sends about itself, queued with the change it reports and retried until it goes out. */
type OutboxMessage = { kind: 'mail.accountDeleted'; email: string };

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
  restorable_until: number | null;
};

/**
 * Run once, when a column is added. Parties rolled before reveals were recorded count as revealed (at 0), so nobody is
 * reminded about parties that rolled long ago.
 */
const BACKFILLS: Record<string, string> = {
  'parties.revealed_at': 'UPDATE parties SET revealed_at = 0 WHERE is_closed = 1',
};

/** How long after a roll a party not revealed yet is brought up again (`unrevealed`). */
export const REVEAL_REMINDER_MS = 30 * 24 * 60 * 60 * 1000;

/** What the user's live-updates watchers are told: a party of theirs rolled, or they revealed their name in it. */
type UserEvent = { type: 'party.rolled'; code: string; name: string } | { type: 'party.revealed'; code: string };

/** Close code for live updates when the session behind them is no more (signed out everywhere, account gone). */
export const SIGNED_OUT = [4401, 'signed out'] as const;

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
    /** When the user revealed whom they give a gift to (see `markRevealed`). */
    revealed_at: 'INTEGER',
    /** Until when a deleted party can be restored (null: a day after `deleted_at`). */
    restorable_until: 'INTEGER',
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

/** How a cancelled email-change link is recorded in `used_magic_links.outcome`. */
const CANCELLED = '!cancelled';

/** The new-party limit counts the parties a user started over this rolling window. */
export const PARTY_STARTS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * One instance per user, addressed by the normalized email (`canonicalEmail`, `env.USER.getByName(email)`). Accounts
 * saved under an older spelling (as typed, or a Gmail address without its dots) stay there until their next sign-in.
 * Holds the profile and the user's party list. The list carries a summary of each party (name, host, protected,
 * closed), kept up to date by `PartyDO`'s outbox through `apply`, so listing parties needs no call to any party.
 *
 * A deleted account leaves a tombstone: `get()` returns null and `apply` writes nothing, so late outbox deliveries
 * can't bring the record back, and the token version is bumped so its session tokens stop working. The next sign-in
 * with the same email starts a new account (new id) on top of it.
 */
export class UserDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private outbox: Outbox<OutboxMessage>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.outbox = new Outbox(this.sql, () => this.ready, messages => this.deliver(messages));
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      // Tables are made on the first write (`ensureSchema`): a read of an address that never signed in stores nothing.
      this.ready = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user'").toArray().length > 0;
      if (this.ready) {
        this.setUp();
      }
    });
  }

  /** Whether this object has its tables, which it gets on its first write. */
  private ready = false;

  /** Makes the tables before a write, the first time. */
  private ensureSchema() {
    if (!this.ready) {
      this.setUp();
      this.ready = true;
    }
  }

  /**
   * Makes any table this release needs that the object doesn't have yet, brings older tables up to date, and lets go
   * of what has expired. Runs when an object with tables starts, and before an object's first write.
   */
  private setUp() {
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
      CREATE TABLE IF NOT EXISTS party_starts (
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS used_magic_links (
        jti TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        request_key TEXT,
        outcome TEXT
      );
      CREATE TABLE IF NOT EXISTS used_proofs (
        jti TEXT PRIMARY KEY,
        request TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL
      );
    `);
    // Party rows stored before summaries existed stay null until refreshed; users get version 0, not deleted.
    for (const [table, added] of Object.entries(ADDED_COLUMNS)) {
      const columns = new Set(this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map(c => c.name));
      for (const [column, definition] of Object.entries(added)) {
        if (!columns.has(column)) {
          this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
          const backfill = BACKFILLS[`${table}.${column}`];
          if (backfill) {
            this.sql.exec(backfill);
          }
        }
      }
    }
    this.forgetExpired();
    // Per-address email counts went to a Rate Limiting binding that stores nothing (`takeAddressLimit`).
    this.sql.exec('DROP TABLE IF EXISTS mail_sent');
  }

  /**
   * Whether `session` still belongs to `user` (`sessionMatches`), and for a bound session, whether its proof is new:
   * a proof works for one request only, so one copied along with its token can't be sent again. Every session check
   * in this object goes through here.
   */
  private holds(user: { id: string; tokenVersion: number } | null | undefined, session: Session): boolean {
    if (!sessionMatches(user, session)) {
      return false;
    }
    const { proof } = session;
    if (!proof) {
      return true;
    }
    this.sql.exec('DELETE FROM used_proofs WHERE expires_at < ?', Date.now());
    this.sql.exec('INSERT OR IGNORE INTO used_proofs (jti, request, expires_at) VALUES (?, ?, ?)', proof.jti, proof.request, proof.until);
    return this.sql.exec<{ request: string }>('SELECT request FROM used_proofs WHERE jti = ?', proof.jti).one().request === proof.request;
  }

  /**
   * Deletes records past their expiry: used links (which can hold a new email), mail and create requests (which can
   * hold an email or a party name), slot reservations and used proofs. Each is also cleaned up when it's next used,
   * but an address used once would otherwise keep them for good. Runs when the object starts.
   */
  private forgetExpired() {
    const now = Date.now();
    for (const table of ['used_magic_links', 'mail_requests', 'create_requests', 'host_reservations', 'used_proofs']) {
      this.sql.exec(`DELETE FROM ${table} WHERE expires_at < ?`, now);
    }
  }

  private row(): UserRow | null {
    if (!this.ready) {
      return null;
    }
    return this.sql.exec<UserRow>('SELECT id, email, name, joined, token_version, deleted_at, changing_until FROM user LIMIT 1').toArray()[0] ?? null;
  }

  /** Returns the user, creating it on the first sign-in, or starting a new account after a deleted one. */
  ensure(email: string): UserRecord {
    this.ensureSchema();
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
    this.ensureSchema();
    const used = this.usedLink(jti);
    if (used) {
      return requestKey && used.request_key === requestKey ? this.get() : null;
    }
    this.sql.exec('INSERT INTO used_magic_links (jti, expires_at, request_key) VALUES (?, ?, ?)', jti, expiresAt, requestKey ?? null);
    return this.ensure(email);
  }

  /**
   * Signs in with a party's emailed link for the member `userId` (`POST /v1/auth/party-link`): returns the user,
   * `'used'` when the link was already used by another request, or `'not_member'` when this address holds no account or
   * another one (deleted, moved to another email, or remade since). That last check comes first, and records and makes
   * nothing: a drawn party keeps a member's old address after an email change, and the link must not make a new account
   * there. Otherwise it works like `redeemMagicLink`: once, and a repeat of the same request (`requestKey`) gets the user
   * again.
   */
  redeemMemberLink(userId: string, jti: string, expiresAt: number, requestKey?: string): UserRecord | 'used' | 'not_member' {
    // An object with no tables has no user, and stays without them.
    const user = this.get();
    if (user?.id !== userId) {
      return 'not_member';
    }
    const used = this.usedLink(jti);
    if (used) {
      return requestKey && used.request_key === requestKey ? user : 'used';
    }
    this.sql.exec('INSERT INTO used_magic_links (jti, expires_at, request_key) VALUES (?, ?, ?)', jti, expiresAt, requestKey ?? null);
    return user;
  }

  /**
   * The user, when the link `jti` was used by this same request (`requestKey`): a retry after a dropped answer. Null
   * otherwise, whether another request used it or nobody did. Uses up nothing, and stores nothing for a new address.
   */
  redeemedBy(jti: string, requestKey: string): UserRecord | null {
    if (!this.ready) {
      return null;
    }
    return this.usedLink(jti)?.request_key === requestKey ? this.get() : null;
  }

  /** How an emailed link was used, or null if it wasn't (forgetting used links that have expired). */
  private usedLink(jti: string): { request_key: string | null; outcome: string | null } | null {
    this.sql.exec('DELETE FROM used_magic_links WHERE expires_at < ?', Date.now());
    return this.sql
      .exec<{ request_key: string | null; outcome: string | null }>('SELECT request_key, outcome FROM used_magic_links WHERE jti = ?', jti)
      .toArray()[0] ?? null;
  }

  /**
   * Whether an emailed account link (`jti`, for `userId`) can still be used, without using it: the same answers as
   * `startAccountChange` gives before it changes anything. A change already running is `'ok'` here (it will finish or
   * be released in a minute).
   */
  checkAccountChange(userId: string, jti: string, ver?: number): 'ok' | 'gone' | 'used' | 'stale' {
    if (!this.ready) {
      return 'gone';
    }
    if (this.usedLink(jti)) {
      return 'used';
    }
    const row = this.row();
    if (!row || row.deleted_at !== null || row.id !== userId) {
      return 'gone';
    }
    return ver !== undefined && ver !== row.token_version ? 'stale' : 'ok';
  }

  /**
   * Starts deleting the account or moving it to another email, from an emailed link: checks the link is for this
   * account (`userId`) and not used yet, marks it used, and returns the user with the slugs of all their parties.
   * Until the change finishes (the account is tombstoned), is aborted, or a minute passes, the account is held: it
   * reads as missing, refuses joins and profile changes, and no other change can start, so the party list can't
   * change under the one running. With `ver`, the link works only while the account's token version is still that
   * (`'stale'` otherwise): a version bump, such as cancelling an email change, voids every link issued before it.
   */
  startAccountChange(userId: string, jti: string, expiresAt: number, request?: { key?: string; outcome?: string; ver?: number }):
    | { ok: true; user: UserRecord; parties: string[] }
    | { ok: false; reason: 'gone' | 'used' | 'busy' | 'stale' }
    | { ok: false; reason: 'repeat'; outcome: string | null } {
    this.ensureSchema();
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
    if (request?.ver !== undefined && request.ver !== row.token_version) {
      return { ok: false, reason: 'stale' };
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

  /**
   * "This wasn't me" from the notice about an email change: uses up the change link (`jti`) so it can't be confirmed,
   * and bumps the token version, which signs out every session and voids every other pending account link. Answers
   * `'too_late'` when the change link was already used to move the account, `'busy'` while a change is running, and
   * `'repeat'` for a repeat of the request that cancelled (same `requestKey`); another use of a used cancel link is
   * `'used'`.
   */
  cancelAccountChange(userId: string, jti: string, expiresAt: number, requestKey?: string): 'cancelled' | 'repeat' | 'used' | 'too_late' | 'gone' | 'busy' {
    this.ensureSchema();
    const used = this.usedLink(jti);
    if (used) {
      if (used.outcome !== CANCELLED) {
        // The change link was used: it is moving the account right now, or has moved it (the account here is gone).
        const row = this.row();
        return row && row.deleted_at === null && isChanging(row) ? 'busy' : 'too_late';
      }
      return requestKey && used.request_key === requestKey ? 'repeat' : 'used';
    }
    const row = this.row();
    if (!row || row.deleted_at !== null || row.id !== userId) {
      return 'gone';
    }
    if (isChanging(row)) {
      return 'busy';
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO used_magic_links (jti, expires_at, request_key, outcome) VALUES (?, ?, ?, ?)',
        jti, expiresAt, requestKey ?? null, CANCELLED,
      );
      this.sql.exec('UPDATE user SET token_version = token_version + 1');
    });
    this.disconnect();
    return 'cancelled';
  }

  /** Releases an account change that could not finish, and the link that started it, so the link can be tried again. */
  abortAccountChange(jti: string): void {
    this.ensureSchema();
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
    this.ensureSchema();
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
        this.putParty(party, 'keep');
      }
      // Reveals aren't carried over: parties already rolled count as revealed, rather than reminding again.
      this.sql.exec('UPDATE parties SET revealed_at = COALESCE(revealed_at, 0) WHERE is_closed = 1');
    });
    return toRecord(row);
  }

  /**
   * Stores a party of the user's. `update` overwrites a stored one (but not when the user revealed their name in it);
   * `keep` leaves a stored one as it is.
   */
  private putParty(
    { slug, name, createdAt, isHost, isProtected, isClosed, closedAt, deletedAt = null, restorableUntil = null }: UserPartyRecord,
    mode: 'update' | 'keep',
  ) {
    const onConflict = mode === 'update'
      ? `ON CONFLICT (slug) DO UPDATE SET name = excluded.name, created_at = excluded.created_at, is_host = excluded.is_host,
         is_protected = excluded.is_protected, is_closed = excluded.is_closed, closed_at = excluded.closed_at, deleted_at = excluded.deleted_at,
         restorable_until = excluded.restorable_until`
      : 'ON CONFLICT (slug) DO NOTHING';
    this.sql.exec(
      `INSERT INTO parties (slug, name, created_at, is_host, is_protected, is_closed, closed_at, deleted_at, restorable_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ${onConflict}`,
      slug, name, createdAt, Number(isHost), Number(isProtected), Number(isClosed), closedAt, deletedAt, restorableUntil,
    );
  }

  /** The user, or null when there is none, the account was deleted, or it is being deleted or moved right now. */
  /**
   * The user, when `session` still belongs to them (see `holds`); null otherwise. The check behind
   * `RequestSession.verify()`.
   */
  check(session: Session): UserRecord | null {
    const user = this.get();
    return this.holds(user, session) ? user : null;
  }

  get(): UserRecord | null {
    const row = this.row();
    return row && row.deleted_at === null && !isChanging(row) ? toRecord(row) : null;
  }

  /**
   * Sets the profile name, the default name for parties the user joins later. Parties already joined keep the
   * name the user joined them with. Returns null, changing nothing, when the session no longer belongs to this user.
   */
  updateName(name: string, session: Session): UserProfile | null {
    const user = this.get();
    if (!this.holds(user, session)) {
      return null;
    }
    this.sql.exec('UPDATE user SET name = ?', name);
    return { ...user!, name, parties: this.partyCounts() };
  }

  /** The user with their party counts (what the profile shows), when `session` still belongs to them; null otherwise. */
  profile(session: Session): UserProfile | null {
    const user = this.check(session);
    return user && { ...user, parties: this.partyCounts() };
  }

  /**
   * Parties the user is in, how many of them rolled their dice, and how many they host. Deleted parties don't count. A
   * party whose roll this list hasn't heard of yet (see `listParties` in src/api/party.ts) counts as not rolled. Only
   * read once the user was found, so the tables are there.
   */
  private partyCounts(): PartyCounts {
    return this.sql.exec<PartyCounts>(
      `SELECT COUNT(*) AS joined, COALESCE(SUM(is_closed = 1), 0) AS rolled, COALESCE(SUM(is_host = 1), 0) AS hosted
       FROM parties WHERE deleted_at IS NULL`,
    ).one();
  }

  /**
   * Ends every session of the account at once ("Sign out everywhere"): bumps the token version, which also voids every
   * pending account link. Changes nothing, and answers false, for a session that no longer belongs to this user.
   */
  signOutEverywhere(session: Session): boolean {
    if (!this.holds(this.get(), session)) {
      return false;
    }
    this.sql.exec('UPDATE user SET token_version = token_version + 1');
    this.disconnect();
    return true;
  }

  /**
   * Deletes the account, leaving a tombstone: the profile and party list are wiped, and every session token issued
   * so far is revoked. An object without a user yet gets a tombstone too, so nothing can be written to it.
   */
  /**
   * Deletes the account (see the class comment). With `notify`, the "it's officially over" email to the account's
   * address is queued in the same transaction and sent by the alarm, with retries.
   */
  async tombstone(notify = false): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const row = this.row();
      if (row) {
        if (notify && row.deleted_at === null) {
          this.outbox.add({ kind: 'mail.accountDeleted', email: row.email });
        }
        // The email goes too: the goodbye email above has its own copy, and a new sign-in replaces the row.
        this.sql.exec("UPDATE user SET name = '', email = '', deleted_at = ?, token_version = token_version + 1", now);
      } else {
        this.sql.exec("INSERT INTO user (id, email, name, joined, token_version, deleted_at) VALUES (?, '', '', ?, 1, ?)", newObjectId(), now, now);
      }
      this.sql.exec('DELETE FROM parties');
    });
    this.disconnect();
    if (this.outbox.pending()) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  private async deliver([message]: OutboxMessage[]) {
    return await sendMail(this.env, message.email, renderAccountDeleted({ assetsUrl: this.env.PUBLIC_URL }));
  }

  /** Sends queued mail; a failed send is retried on the next alarm (see Outbox). */
  async alarm() {
    await this.outbox.process(() => true, false);
    const next = this.outbox.nextAttemptAt();
    if (next !== null) {
      await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
    }
  }

  /** Number of undelivered outbox messages. Used by tests. */
  pendingOutbox(): number {
    return this.outbox.pending();
  }

  /**
   * Checks the open-party limit and, when there is room, holds a slot for the party about to be created, in one step:
   * concurrent creates each see the slots the others hold. The slot is released when the new party lands in the list
   * (`releaseHostSlot`) or after HOST_RESERVATION_TTL_MS. With `newParties`, a new party also counts against that many
   * started per PARTY_STARTS_WINDOW_MS (restoring one doesn't). Returns null when there is no user or the session no
   * longer belongs to them.
   */
  startHosting(
    limit: number,
    session: Session,
    request?: { key: string; id: string; slug: string; detail?: string },
    newParties?: number,
  ): HostingStart | null {
    const user = this.get();
    if (!this.holds(user, session)) {
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
      return { ...user!, openHostedParties: open + held, allowed: false, limit: 'open' };
    }
    if (newParties !== undefined) {
      // Deleting a party frees its slot at once, so the open-party limit alone doesn't bound how many get made.
      this.sql.exec('DELETE FROM party_starts WHERE at <= ?', now - PARTY_STARTS_WINDOW_MS);
      if (this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM party_starts').one().n >= newParties) {
        return { ...user!, openHostedParties: open + held, allowed: false, limit: 'new' };
      }
      this.sql.exec('INSERT INTO party_starts (at) VALUES (?)', now);
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
    this.ensureSchema();
    this.sql.exec('UPDATE create_requests SET slug = ? WHERE key = ?', slug, key);
  }

  /**
   * Claims an account email request by its request id. `'repeat'` when the same request (same key and detail) was
   * claimed in the last MAIL_REQUEST_TTL_MS, so the caller answers it without emailing again. The same key with
   * another detail (say, a different new address) is a new request and replaces the old claim.
   */
  private claimMailRequest(key: string, detail: string): 'claimed' | 'repeat' {
    const now = Date.now();
    this.sql.exec('DELETE FROM mail_requests WHERE expires_at < ?', now);
    const claimed = this.sql.exec<{ detail: string }>('SELECT detail FROM mail_requests WHERE key = ?', key).toArray()[0];
    if (claimed?.detail === detail) {
      return 'repeat';
    }
    this.sql.exec('INSERT OR REPLACE INTO mail_requests (key, detail, expires_at) VALUES (?, ?, ?)', key, detail, now + MAIL_REQUEST_TTL_MS);
    return 'claimed';
  }

  /** Frees a claimed request whose email didn't go out, so a retry of it sends one. */
  releaseMailRequest(key: string, detail: string): void {
    if (this.ready) {
      this.sql.exec('DELETE FROM mail_requests WHERE key = ? AND detail = ?', key, detail);
    }
  }

  /**
   * Starts an account email request from a signed-in user, in one call: checks the session, then claims the request
   * id when there is one. Returns the user, `'repeat'` for a request already claimed, or null when the session no
   * longer belongs to this user. (The per-address limit is a Rate Limiting binding, taken by the Worker.)
   */
  beginMailRequest(session: Session, key: string | undefined, detail: string): UserRecord | 'repeat' | null {
    const user = this.get();
    if (!this.holds(user, session)) {
      return null;
    }
    return key && this.claimMailRequest(key, detail) === 'repeat' ? 'repeat' : user;
  }

  /**
   * Applies a batch of changes from a party, in order, in one transaction. Safe to retry.
   * Writes nothing to a deleted account, and nothing when `session` is given and no longer holds (`holds`) or the
   * account is held by an account change, so a party can verify a joining session in the call it makes anyway. Returns
   * the user as it is afterwards, or null when there is none, it was deleted, or `session` doesn't hold.
   */
  apply(updates: UserUpdate[], session?: Session): UserRecord | null {
    this.ensureSchema();
    const row = this.row();
    if (row?.deleted_at) {
      return null;
    }
    const user = row && toRecord(row);
    if (session && !this.holds(user, session)) {
      return null;
    }
    if (session && isChanging(row!)) {
      // Held by an account change: a join now would be missed by it.
      return null;
    }
    let name = user?.name;
    const rolled: UserEvent[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const update of updates) {
        switch (update.type) {
          case 'addParty': {
            const { slug, name: partyName, isClosed, deletedAt } = update.party;
            const before = this.sql.exec<{ is_closed: number | null }>('SELECT is_closed FROM parties WHERE slug = ?', slug).toArray()[0];
            this.putParty(update.party, 'update');
            if (isClosed && !deletedAt && !before?.is_closed) {
              rolled.push({ type: 'party.rolled', code: slug, name: partyName });
            }
            break;
          }
          case 'removeParty':
            this.sql.exec('DELETE FROM parties WHERE slug = ?', update.slug);
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
    rolled.forEach(event => this.tell(event));
    return user && { ...user, name: name! };
  }

  /**
   * Parties of the user's that rolled in the last REVEAL_REMINDER_MS and that they haven't revealed their name in yet,
   * newest roll first (at most 10). Null when the session no longer belongs to this user.
   */
  unrevealed(session: Session): { slug: string; name: string; closedAt: number }[] | null {
    if (!this.holds(this.get(), session)) {
      return null;
    }
    return this.sql.exec<{ slug: string; name: string; closed_at: number }>(
      `SELECT slug, name, closed_at FROM parties
       WHERE is_closed = 1 AND revealed_at IS NULL AND deleted_at IS NULL AND closed_at >= ?
       ORDER BY closed_at DESC LIMIT 10`,
      Date.now() - REVEAL_REMINDER_MS,
    ).toArray().map(row => ({ slug: row.slug, name: row.name, closedAt: row.closed_at }));
  }

  /**
   * Records that the user revealed their name in a rolled party (not again once recorded), and tells their other
   * tabs, so a reminder still showing there goes away. False for a party that isn't theirs or hasn't rolled; null when
   * the session no longer belongs to this user.
   */
  markRevealed(slug: string, session: Session): boolean | null {
    if (!this.holds(this.get(), session)) {
      return null;
    }
    const party = this.sql.exec<{ revealed_at: number | null }>('SELECT revealed_at FROM parties WHERE slug = ? AND is_closed = 1', slug).toArray()[0];
    if (!party) {
      return false;
    }
    if (party.revealed_at === null) {
      this.sql.exec('UPDATE parties SET revealed_at = ? WHERE slug = ?', Date.now(), slug);
      this.tell({ type: 'party.revealed', code: slug });
    }
    return true;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Live updates (src/api/live.ts): the user's own events, on the home screen. Watchers connect with the hibernation
  // API; "ping" is answered without waking the object. A session that ends (signed out everywhere, account gone)
  // disconnects them.

  /** A WebSocket upgrade passed on by the Worker, for the user (and token version) in the live headers. */
  async fetch(request: Request): Promise<Response> {
    const user = this.get();
    const userId = request.headers.get(LIVE_USER_HEADER);
    const version = request.headers.get(LIVE_VERSION_HEADER);
    const current = user && user.id === userId && (version === null || Number(version) === user.tokenVersion);
    if (!current || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response(null, { status: 403 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [userId]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Watchers only listen: anything they send is ignored. */
  async webSocketMessage() {}

  private tell(event: UserEvent) {
    const message = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // Closing already.
      }
    }
  }

  /** Ends every watcher's updates: the session they were opened with is no more. */
  private disconnect() {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(...SIGNED_OUT);
      } catch {
        // Closing already.
      }
    }
  }

  /**
   * The user's parties, newest first. Parties created at the same time are ordered by slug, so `after` (the last
   * row of the previous page) continues exactly where that page ended.
   */
  listParties(first: number, after?: PartyListCursor | null, session?: Session): UserPartyListItem[] | null {
    // With a session, the list is only for the account the session belongs to (not a newer one on the same email).
    if (session && !this.holds(this.get(), session)) {
      return null;
    }
    if (!this.ready) {
      return [];
    }
    const columns = 'slug, name, created_at, is_host, is_protected, is_closed, closed_at, deleted_at, restorable_until';
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
        restorableUntil: row.restorable_until,
      }));
  }
}
