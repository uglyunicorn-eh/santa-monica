import { DurableObject } from 'cloudflare:workers';

import { Env } from 'src/env';
import { renderPartyDue, renderPartyInvite, renderPartyNotification, renderPartyPruned, sendMail } from 'src/mail';
import santaShuffle from 'src/utils/santaShuffle';
import { Session } from 'src/utils/session';

import { newObjectId } from 'src/utils/ids';
import { LIVE_USER_HEADER } from 'src/utils/liveHeaders';
import { takeAddressLimit, takeAllMail } from 'src/api/rateLimit';
import { STATS_NAME } from './StatsDO';
import { Outbox, RetryLater } from './outbox';

import { CreatePartyInput, ForgetMemberResult, Member, PartyErrorCode, PartyResult, PartyUserError, PartyView, UserPartyRecord, UserRecord, UserUpdate } from './types';


type PartyRow = {
  id: string;
  slug: string;
  name: string;
  password: string | null;
  host_id: string;
  is_closed: number;
  created_at: number;
  /** When the host drew the party. Parties drawn before this column existed have null. */
  closed_at: number | null;
  deleted_at: number | null;
  /** Invite emails sent in all, for MAX_PARTY_INVITES (the invites themselves are kept only for REINVITE_AFTER_MS). */
  invites_sent: number;
  /** When an open party is deleted for want of activity: PRUNE_AFTER_MS after its last write (`touch`). */
  prune_at: number | null;
  /** Until when a deleted party can be restored. Parties deleted before this column existed have null (24 h). */
  restorable_until: number | null;
  /** When the party is due, if the host set it. Shown as a countdown; nothing happens when it passes. */
  due_at: number | null;
  /** When the host's reminder goes out (`reminderAt`); null once sent, or when there's none. */
  remind_at: number | null;
};

type MembershipRow = {
  member_id: string;
  member_email: string | null;
  name: string;
  target_id: string | null;
  target_name: string | null;
  joined_at: number;
};

// user.sync sends the member's current view of this party (added, closed, or removed if they left). It is computed at
// delivery time, so it is always current and safe to repeat. A sync from creating a party carries the host's slot
// reservation (see UserDO.startHosting), released on delivery.
// user.setNameIfEmpty gives a new member's profile the name they joined with, unless they already have one.
type OutboxMessage =
  | { kind: 'user.sync'; email: string; reservation?: string }
  | { kind: 'user.setNameIfEmpty'; email: string; name: string; memberId?: string }
  // Sent when the party is gone for good (erased after deletion, or its host's account was deleted): the party row is
  // gone, so the slug travels with the message.
  | { kind: 'user.partyPurged'; email: string; slug: string }
  | { kind: 'mail.partyNotification'; email: string; partyName: string; slug: string }
  // To the host, the day before the party's due time (`remindIfDue`).
  | { kind: 'mail.partyDue'; email: string; partyName: string; slug: string; members: number }
  // To the host, when an open party was deleted for want of activity (`pruneIfDue`).
  | { kind: 'mail.partyPruned'; email: string; partyName: string; slug: string; restorableUntil: number }
  // An invite from the host. Counted against the recipient's per-address limit when it goes out; over it, it's dropped.
  | { kind: 'mail.partyInvite'; email: string; hostName: string; partyName: string; slug: string; isProtected: boolean };



/** The joining session's token version and proof, checked by the user's object (`UserDO.holds`, see `Session`). */
export type JoinCheck = Pick<Session, 'tokenVersion' | 'proof'>;

/** How long a party the host deleted can be restored. After that it is erased for good. */
export const RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When the host is reminded of a party's due time: the day before it, at the time of day the party was created (a
 * time the host is likely around, in whatever time zone they're in). That's the moment with the creation's clock time
 * nearest to 24 hours before the due time, so 12 to 36 hours before it. Null when that moment has passed already.
 */
export function reminderAt(createdAt: number, dueAt: number): number | null {
  const target = dueAt - DAY_MS;
  const timeOfDay = ((createdAt % DAY_MS) + DAY_MS) % DAY_MS;
  let at = target - (((target % DAY_MS) + DAY_MS) % DAY_MS) + timeOfDay;
  if (at - target > DAY_MS / 2) {
    at -= DAY_MS;
  } else if (target - at > DAY_MS / 2) {
    at += DAY_MS;
  }
  return at > createdAt ? at : null;
}

/** An open party with no activity (a write by a person) for this long is deleted, and its host told by email. */
export const PRUNE_AFTER_MS = 45 * 24 * 60 * 60 * 1000;

/** How long a party deleted for want of activity can be restored. */
export const PRUNED_RESTORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * When auto-prune came in. A party that had already gone PRUNE_AFTER_MS without activity before then is erased at
 * once, with no email and no restore: its host hasn't been near it in a long time. It must not be later than the
 * deploy: a party due after it gets the email and the week to restore it.
 */
export const AUTO_PRUNE_SINCE = Date.UTC(2026, 9, 27);

// Columns added after the first release, by table. Parties created before them get the columns on their next start.
const ADDED_COLUMNS: Record<string, Record<string, string>> = {
  party: {
    closed_at: 'INTEGER', deleted_at: 'INTEGER', invites_sent: 'INTEGER NOT NULL DEFAULT 0', prune_at: 'INTEGER', restorable_until: 'INTEGER',
    due_at: 'INTEGER', remind_at: 'INTEGER',
  },
};

/** Wrong secret phrases one person can try on a party within PHRASE_GUESS_WINDOW_MS before having to wait. */
export const MAX_PHRASE_GUESSES = 5;
export const PHRASE_GUESS_WINDOW_MS = 15 * 60 * 1000;
/**
 * Wrong secret phrases a party takes from everyone together within PHRASE_GUESS_WINDOW_MS. The per-person limit alone
 * can be multiplied by signing up many times; this one can't. A correct phrase always gets through it.
 */
export const MAX_PARTY_PHRASE_GUESSES = 20;
/** People a party can hold, host included. Keeps its participant list, its emails and the draw a bounded size. */
export const MAX_PARTY_MEMBERS = 100;

/** What watchers get after a change: just that, so they fetch their own view (which differs per member). */
const CHANGED = JSON.stringify({ type: 'party.changed' });

/** Close codes for live updates: the watcher left (or their account is gone), or the party is gone for them. */
export const LEFT = [4403, 'left the party'] as const;
export const GONE = [4410, 'party is gone'] as const;
/** The `phrase_guesses` row that counts the whole party's wrong guesses (member ids are never empty). */
const WHOLE_PARTY = '';


/** A refused change, in the same order as the API's `fail(code, message, field)`. */
const fail = (code: PartyErrorCode, message: string, fieldName: string | null = null) => ({ ok: false as const, error: { code, fieldName, message } });

const notLoggedIn = fail('unauthenticated', 'You must be logged in before joining the party.');
const tryAgain = fail('unavailable', "We couldn't reach your account. Please try again in a minute.");

/** Invite emails one party can send in all, so a party can't be used to email lots of strangers. */
export const MAX_PARTY_INVITES = 50;
/** One address gets at most one invite to a party within this window; asking again sooner is answered as done. */
export const REINVITE_AFTER_MS = 24 * 60 * 60 * 1000;

/** What the host asked to invite, address by address. */
export type InviteResult =
  | { ok: true; invited: string[]; alreadyInvited: string[]; alreadyJoined: string[]; invitesLeft: number }
  | { ok: false; error: PartyUserError };

const closedToNewMembers = fail('conflict', 'Party is already packed. Sorry, we cannot accept a new participant...', 'party');
const partyIsFull = fail('conflict', `This party is full: it already has ${MAX_PARTY_MEMBERS} people.`, 'party');

/**
 * One instance per party, addressed by the party slug (`env.PARTY.getByName(slug)`).
 * The source of truth for the party and its memberships. Changes that other objects need to know about
 * (users' party lists and names, notification emails) are written to the outbox in the same transaction.
 * User updates are delivered before the mutation returns; mail and anything that failed is delivered by the alarm,
 * with retries.
 */
export class PartyDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private schemaReady = false;
  private outbox: Outbox<OutboxMessage>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.outbox = new Outbox(this.sql, () => this.hasSchema(), messages => this.deliver(messages));
    // Watchers' keep-alives are answered without waking the party.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // The schema is created on the first write only, so looking up an unknown code does not store anything.
  private hasSchema(): boolean {
    if (!this.schemaReady && this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'party'").toArray().length) {
      this.migrate();
    }
    return this.schemaReady;
  }

  /**
   * Adds the columns introduced after a party was created, and lets go of what it no longer needs (`tidy`). Runs once
   * per start, when the party is first read.
   */
  private migrate() {
    this.schemaReady = true;
    const added: string[] = [];
    for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
      const existing = new Set(this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map(c => c.name));
      for (const [column, definition] of Object.entries(columns)) {
        if (!existing.has(column)) {
          this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
          added.push(`${table}.${column}`);
        }
      }
    }
    // Invites the host sent in the last REINVITE_AFTER_MS, by address, so a repeat isn't sent again. Older ones are
    // deleted: the address was only ever needed for that. (`sent` is from when invites were kept for good.)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS invites (
        email TEXT PRIMARY KEY,
        invited_at INTEGER NOT NULL,
        sent INTEGER NOT NULL DEFAULT 1
      )
    `);
    if (added.includes('party.invites_sent')) {
      // The invite cap was the sum over the invites kept; now it's a counter, so they can go.
      this.sql.exec('UPDATE party SET invites_sent = (SELECT COALESCE(SUM(sent), 0) FROM invites)');
    }
    if (added.includes('party.prune_at')) {
      // From the last activity known: when it was made, when someone last joined, or when the host last invited.
      this.sql.exec(
        `UPDATE party SET prune_at = MAX(created_at, COALESCE((SELECT MAX(joined_at) FROM memberships), 0),
           COALESCE((SELECT MAX(invited_at) FROM invites), 0)) + ?`,
        PRUNE_AFTER_MS,
      );
    }
    // Wrong secret phrases per person, so guessing one is slow (see MAX_PHRASE_GUESSES).
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS phrase_guesses (
        member_id TEXT PRIMARY KEY,
        failures INTEGER NOT NULL,
        first_failed_at INTEGER NOT NULL
      )
    `);
    this.tidy();
    // A party that starts for any reason gets its alarm (an old one may be due to be pruned). Not awaited, since this
    // runs inside a read; the output gate holds the answer until the alarm is stored.
    const next = this.nextAlarm();
    if (next !== null) {
      void this.ctx.storage.setAlarm(next);
    }
  }

  /** Marks a write by a person: the party is pruned PRUNE_AFTER_MS from now. Runs inside the write's transaction. */
  private touch() {
    this.sql.exec('UPDATE party SET prune_at = ?', Date.now() + PRUNE_AFTER_MS);
  }

  /**
   * Lets go of personal data the party no longer needs. Runs when the party starts and after the outbox runs:
   * - invited addresses older than REINVITE_AFTER_MS, and all of them once the party is drawn (nobody can join then);
   * - members' emails once the party is drawn and the outbox is empty. After the draw they're only used to deliver
   *   what the draw queued; everything else goes by member id (views, email changes, account deletion).
   */
  private tidy() {
    const party = this.sql.exec<{ is_closed: number }>('SELECT is_closed FROM party LIMIT 1').toArray()[0];
    if (party?.is_closed) {
      this.sql.exec('DELETE FROM invites');
      // Parties from before the outbox have no table for it, and nothing queued.
      const hasOutbox = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'outbox'").toArray().length > 0;
      if (!hasOutbox || !this.sql.exec('SELECT 1 FROM outbox LIMIT 1').toArray().length) {
        this.sql.exec('UPDATE memberships SET member_email = NULL WHERE member_email IS NOT NULL');
      }
    } else {
      this.sql.exec('DELETE FROM invites WHERE invited_at <= ?', Date.now() - REINVITE_AFTER_MS);
    }
  }

  /**
   * How long `memberId` (or WHOLE_PARTY) must wait before guessing the secret phrase again after `max` wrong guesses,
   * or 0 when they may guess now.
   */
  private guessLockout(memberId: string, max: number): number {
    const row = this.sql
      .exec<{ failures: number; first_failed_at: number }>('SELECT failures, first_failed_at FROM phrase_guesses WHERE member_id = ?', memberId)
      .toArray()[0];
    const left = row ? row.first_failed_at + PHRASE_GUESS_WINDOW_MS - Date.now() : 0;
    return row && row.failures >= max && left > 0 ? left : 0;
  }

  /** Counts a wrong secret phrase, starting a new window when the last one has passed. */
  private recordWrongGuess(memberId: string) {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO phrase_guesses (member_id, failures, first_failed_at) VALUES (?, 1, ?)
       ON CONFLICT (member_id) DO UPDATE SET
         failures = CASE WHEN first_failed_at + ? <= excluded.first_failed_at THEN 1 ELSE failures + 1 END,
         first_failed_at = CASE WHEN first_failed_at + ? <= excluded.first_failed_at THEN excluded.first_failed_at ELSE first_failed_at END`,
      memberId, now, PHRASE_GUESS_WINDOW_MS, PHRASE_GUESS_WINDOW_MS,
    );
  }

  private ensureSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS party (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        password TEXT,
        host_id TEXT NOT NULL,
        is_closed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        closed_at INTEGER,
        deleted_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS memberships (
        member_id TEXT PRIMARY KEY,
        member_email TEXT,
        name TEXT NOT NULL,
        target_id TEXT,
        target_name TEXT,
        joined_at INTEGER NOT NULL
      );
      -- A row here means the party is gone for good: its code is never handed out again.
      CREATE TABLE IF NOT EXISTS cancelled (
        slug TEXT PRIMARY KEY,
        cancelled_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL
      );
    `);
    // An existing party's tables were left as they were: bring them up to date too.
    this.migrate();
  }

  private party(): PartyRow | null {
    if (!this.hasSchema()) {
      return null;
    }
    return this.sql.exec<PartyRow>('SELECT * FROM party LIMIT 1').toArray()[0] ?? null;
  }

  /** Drops queued messages (user updates and mail) addressed to this email. */
  private dropQueued(email: string) {
    this.outbox.drop(email);
  }

  private membership(userId: string): MembershipRow | null {
    return this.sql.exec<MembershipRow>('SELECT * FROM memberships WHERE member_id = ?', userId).toArray()[0] ?? null;
  }

  private memberCount(): number {
    return this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM memberships').one().n;
  }

  private enqueue(message: OutboxMessage) {
    this.outbox.add(message);
  }

  private async deliverSoon() {
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** Delivers queued user updates now, so the caller's party list and name are current when the mutation returns. */
  private async deliverUserUpdates() {
    await this.runOutbox(message => message.kind.startsWith('user.'));
  }

  /** Whether the outbox still holds changes for this user (waiting for a retry, or being delivered). */
  private hasQueuedUserUpdates(email: string): boolean {
    return this.outbox.hasUserUpdates(email);
  }

  /** The party's summary in a member's list. */
  private summary(party: PartyRow, memberId: string): UserPartyRecord {
    return {
      slug: party.slug,
      name: party.name,
      createdAt: party.created_at,
      isHost: memberId === party.host_id,
      isProtected: Boolean(party.password),
      isClosed: Boolean(party.is_closed),
      closedAt: party.closed_at,
      deletedAt: party.deleted_at,
      restorableUntil: this.restorableUntil(party),
    };
  }

  /** The party as a member sees it in their list, or its removal if they are no longer a member. */
  private memberUpdate(email: string): UserUpdate {
    const party = this.party()!;
    const membership = this.sql
      .exec<{ member_id: string }>('SELECT member_id FROM memberships WHERE member_email = ?', email)
      .toArray()[0];
    // A deleted party leaves everyone's list but the host's, where it waits to be restored.
    if (!membership || (party.deleted_at && membership.member_id !== party.host_id)) {
      return { type: 'removeParty', slug: party.slug };
    }
    return { type: 'addParty', party: this.summary(party, membership.member_id) };
  }

  private buildView(party: PartyRow, userId?: string): PartyView {
    const isHost = Boolean(userId && userId === party.host_id);
    const isClosed = Boolean(party.is_closed);
    const membership = userId ? this.membership(userId) : null;
    const isJoined = Boolean(membership);

    let participants: string[] | null = null;
    if (userId && membership) {
      const rows = isHost
        ? this.sql.exec<{ name: string }>('SELECT name FROM memberships ORDER BY name').toArray()
        : this.sql.exec<{ name: string }>(
          'SELECT name FROM memberships WHERE member_id != ? ORDER BY joined_at LIMIT 3', userId,
        ).toArray();
      participants = rows.map(row => row.name);
    }

    const target = isClosed && membership?.target_id
      // close() always sets target_id and target_name together.
      ? { id: membership.target_id, name: membership.target_name! }
      : null;

    return {
      id: party.id,
      slug: party.slug,
      name: party.name,
      password: isHost ? party.password : null,
      isProtected: Boolean(party.password),
      isHost,
      isJoined,
      isClosed,
      createdAt: party.created_at,
      closedAt: party.closed_at,
      deletedAt: party.deleted_at,
      restorableUntil: this.restorableUntil(party),
      dueAt: party.due_at ?? null,
      participantCount: isJoined ? this.memberCount() : null,
      participants,
      target,
    };
  }

  /** The party as this user sees it. A deleted party is visible only to its host, until it can't be restored. */
  // -------------------------------------------------------------------------------------------------------------------
  // Changes. Each one tells the party's watchers (see "Live updates" below) once it's done.

  async join(member: Member, name: string, password: string | null, check?: JoinCheck): Promise<PartyResult> {
    return this.told(await this.joinNow(member, name, password, check));
  }

  /** Leaving also ends the leaver's live updates. */
  async leave(userId: string): Promise<PartyResult> {
    const result = await this.leaveNow(userId);
    if (result.ok) {
      this.disconnect(LEFT, userId);
    }
    return this.told(result);
  }

  async close(userId: string): Promise<PartyResult> {
    return this.told(await this.closeNow(userId));
  }

  /**
   * Emails an invite to each address (host only, while the party is open). Members and addresses invited in the last
   * REINVITE_AFTER_MS are skipped, so a repeated request sends nothing again. Refused as a whole when the party
   * would go over MAX_PARTY_INVITES. `emails` are canonical addresses (`canonicalEmail`).
   */
  async invite(userId: string, emails: string[]): Promise<InviteResult> {
    const party = this.liveParty();
    if (!party) {
      return fail('not_found', 'Party does not exist.', 'party');
    }
    if (party.host_id !== userId) {
      return fail('forbidden', 'Only the host can invite people to the party.', 'party');
    }
    if (party.is_closed) {
      return fail('conflict', 'The dice are already rolled: nobody new can join this party.', 'party');
    }
    // Invites say who sent them: the name the host goes by in this party (the host can't leave, so it's always there).
    const hostName = this.membership(userId)!.name;
    const now = Date.now();
    this.tidy();
    const members = new Set(this.sql.exec<{ member_email: string | null }>('SELECT member_email FROM memberships').toArray()
      .map(row => row.member_email));
    const recent = new Set(this.sql.exec<{ email: string }>('SELECT email FROM invites').toArray().map(row => row.email));
    const invited: string[] = [];
    const alreadyInvited: string[] = [];
    const alreadyJoined: string[] = [];
    for (const email of new Set(emails)) {
      (members.has(email) ? alreadyJoined : recent.has(email) ? alreadyInvited : invited).push(email);
    }
    const used = party.invites_sent;
    if (used + invited.length > MAX_PARTY_INVITES) {
      const left = MAX_PARTY_INVITES - used;
      return fail(
        'rate_limited',
        left ? `This party can send only ${left} more invite${left === 1 ? '' : 's'}.` : 'This party has sent all the invites it can. Share its link instead.',
        'emails',
      );
    }
    this.ctx.storage.transactionSync(() => {
      for (const email of invited) {
        this.sql.exec('INSERT OR REPLACE INTO invites (email, invited_at) VALUES (?, ?)', email, now);
        this.enqueue({ kind: 'mail.partyInvite', email, hostName, partyName: party.name, slug: party.slug, isProtected: Boolean(party.password) });
      }
      this.sql.exec('UPDATE party SET invites_sent = invites_sent + ?', invited.length);
      this.touch();
    });
    if (invited.length) {
      // Delivers the invites now, and sets the alarm that deletes them once REINVITE_AFTER_MS has passed.
      await this.deliverSoon();
    }
    return { ok: true, invited, alreadyInvited, alreadyJoined, invitesLeft: MAX_PARTY_INVITES - used - invited.length };
  }

  /** Only the host can still see a deleted party (to restore it): everyone else stops watching. */
  async delete(userId: string): Promise<PartyResult> {
    const result = await this.deleteNow(userId);
    if (result.ok) {
      this.disconnect(GONE, ...this.watchers().filter(watcher => watcher !== userId));
    }
    return this.told(result);
  }

  async restore(userId: string, reservation?: string): Promise<PartyResult> {
    return this.told(await this.restoreNow(userId, reservation));
  }

  /** A deleted account stops watching; a party deleted with it ends everyone's updates. */
  async forgetMember(userId: string, email: string): Promise<ForgetMemberResult> {
    const result = await this.forgetMemberNow(userId, email);
    if (result === 'deleted') {
      this.disconnect(GONE);
    } else if (result !== 'none') {
      this.disconnect(LEFT, userId);
      this.broadcast();
    }
    return result;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Live updates (src/api/live.ts). Watchers connect with the hibernation API (tagged with their user id) and get
  // `{"type":"party.changed"}` after every change, then fetch their own view. "ping" is answered by the runtime without
  // waking the party. Members may watch, and the host of a deleted party, who can still see it.

  /** A WebSocket upgrade passed on by the Worker, for the user in LIVE_USER_HEADER. */
  async fetch(request: Request): Promise<Response> {
    const userId = request.headers.get(LIVE_USER_HEADER);
    const party = this.party();
    const mayWatch = userId && party && this.view(userId) && (party.host_id === userId || this.membership(userId));
    if (!mayWatch || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response(null, { status: 403 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [userId]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Watchers only listen (their keep-alive "ping" never reaches here): anything else they send is ignored. */
  async webSocketMessage() {}

  /** The user ids watching right now. */
  private watchers(): string[] {
    return [...new Set(this.ctx.getWebSockets().flatMap(ws => this.ctx.getTags(ws)))];
  }

  private broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(CHANGED);
      } catch {
        // Closing already; it's gone from the list next time.
      }
    }
  }

  /** Tells the watchers about a change that went through. */
  private told<R extends { ok: boolean }>(result: R): R {
    if (result.ok) {
      this.broadcast();
    }
    return result;
  }

  /** Ends the live updates of these users (everyone, without any), with a close code the client can act on. */
  private disconnect([code, reason]: readonly [number, string], ...userIds: string[]) {
    const sockets = userIds.length ? userIds.flatMap(id => this.ctx.getWebSockets(id)) : this.ctx.getWebSockets();
    for (const ws of sockets) {
      try {
        ws.close(code, reason);
      } catch {
        // Closing already.
      }
    }
  }

  view(userId?: string): PartyView | null {
    const party = this.party();
    if (!party || (party.deleted_at && (party.host_id !== userId || this.restoreExpired(party)))) {
      return null;
    }
    return this.buildView(party, userId);
  }

  /** Until when a deleted party can be restored; parties deleted before `restorable_until` existed had 24 hours. */
  private restorableUntil(party: PartyRow): number | null {
    return party.deleted_at ? party.restorable_until ?? party.deleted_at + RESTORE_WINDOW_MS : null;
  }

  private restoreExpired(party: PartyRow) {
    const until = this.restorableUntil(party);
    return until !== null && Date.now() >= until;
  }

  /** The party unless it was deleted: joining, leaving and closing treat a deleted party as gone. */
  private liveParty(): PartyRow | null {
    const party = this.party();
    return party && !party.deleted_at ? party : null;
  }

  /** Creates the party. Returns `conflict` when the slug is already taken, so the caller can pick another one. */
  async create(input: CreatePartyInput & { id: string; slug: string }): Promise<PartyResult | { ok: false; conflict: true }> {
    this.ensureSchema();
    const existing = this.party();
    if (existing && existing.id === input.id && !existing.deleted_at && this.membership(input.host.id)) {
      // A repeat of a request that already created this party.
      return { ok: true, view: this.buildView(existing, input.host.id) };
    }
    if (existing || this.sql.exec('SELECT 1 FROM cancelled LIMIT 1').toArray().length) {
      return { ok: false, conflict: true };
    }
    const now = Date.now();
    const party: PartyRow = {
      id: input.id,
      slug: input.slug,
      name: input.name,
      password: input.password,
      host_id: input.host.id,
      is_closed: 0,
      created_at: now,
      closed_at: null,
      deleted_at: null,
      invites_sent: 0,
      prune_at: now + PRUNE_AFTER_MS,
      restorable_until: null,
      due_at: input.dueAt ?? null,
      remind_at: input.dueAt ? reminderAt(now, input.dueAt) : null,
    };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO party (id, slug, name, password, host_id, is_closed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
        party.id, party.slug, party.name, party.password, party.host_id, party.created_at,
      );
      this.sql.exec('UPDATE party SET due_at = ?, remind_at = ?', party.due_at, party.remind_at);
      this.touch();
      this.sql.exec(
        'INSERT INTO memberships (member_id, member_email, name, joined_at) VALUES (?, ?, ?, ?)',
        input.host.id, input.host.email, input.host.name, now,
      );
      if (input.host.email) {
        this.enqueue({ kind: 'user.sync', email: input.host.email, reservation: input.reservation });
      }
    });
    await this.deliverUserUpdates();
    return { ok: true, view: this.buildView(party, input.host.id) };
  }

  /**
   * Adds a member. With `check`, the joining session is verified in the call that updates the member's UserDO anyway
   * (no extra call), before the membership is stored: the UserDO gets the party summary and the name together with the
   * session, and writes nothing if the account was deleted or the token revoked. Then the join fails and nothing was
   * stored anywhere. When older changes for them are still queued (sending this one first would reorder them), the
   * session is checked on its own and the join goes through the outbox. If the user can't be reached, the join is
   * refused: it never goes through unchecked. Joins without `check` (only tests and internal callers) skip the check.
   */
  private async joinNow(member: Member, name: string, password: string | null, check?: JoinCheck): Promise<PartyResult> {
    const party = this.liveParty();
    if (!party) {
      return fail('not_found', 'Party does not exist.', 'party');
    }
    if (this.membership(member.id)) {
      // A repeat answers with the member's view, so the session is checked first, like for any other join.
      if (check && member.email) {
        const holds = await this.checkSession(member.email, { userId: member.id, ...check });
        if (holds !== true) {
          return holds === false ? notLoggedIn : tryAgain;
        }
        // The party may have changed during the check: gone is not found; left meanwhile shows it as they now see it.
        const current = this.liveParty();
        if (!current) {
          return fail('not_found', 'Party does not exist.', 'party');
        }
        return { ok: true, view: this.buildView(current, member.id) };
      }
      return { ok: true, view: this.buildView(party, member.id) };
    }
    if (party.is_closed) {
      return closedToNewMembers;
    }
    const waitMessage = (ms: number) => {
      const minutes = Math.ceil(ms / 60_000);
      return `That's a lot of wrong guesses! Please ask your friend for the secret phrase and try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
    };
    const lockedFor = this.guessLockout(member.id, MAX_PHRASE_GUESSES);
    if (lockedFor) {
      return fail('rate_limited', waitMessage(lockedFor), 'password');
    }
    if ((party.password || '').toUpperCase() !== (password || '').toUpperCase()) {
      // Too many wrong guesses at this party from everyone: refuse more for now, without counting them.
      const partyLockedFor = this.guessLockout(WHOLE_PARTY, MAX_PARTY_PHRASE_GUESSES);
      if (partyLockedFor) {
        return fail('rate_limited', waitMessage(partyLockedFor), 'password');
      }
      this.recordWrongGuess(member.id);
      this.recordWrongGuess(WHOLE_PARTY);
      return fail('forbidden', "Hmm... Seems you've got a wrong secret phrase. Please try a different one or ask your friend for a hint.", 'password');
    }
    this.sql.exec('DELETE FROM phrase_guesses WHERE member_id = ?', member.id);
    if (this.memberCount() >= MAX_PARTY_MEMBERS) {
      return partyIsFull;
    }
    const displayName = name || member.name;
    if (!displayName) {
      return fail('invalid', 'We were unable to get your name.', 'name');
    }

    if (check && member.email) {
      if (!this.hasQueuedUserUpdates(member.email)) {
        return await this.checkedJoin(party, { ...member, email: member.email }, displayName, check);
      }
      const holds = await this.checkSession(member.email, { userId: member.id, ...check });
      if (holds !== true) {
        return holds === false ? notLoggedIn : tryAgain;
      }
      // Other requests may have reached the party meanwhile.
      const current = this.liveParty();
      if (!current) {
        return fail('not_found', 'Party does not exist.', 'party');
      }
      if (this.membership(member.id)) {
        return { ok: true, view: this.buildView(current, member.id) };
      }
      if (current.is_closed) {
        return closedToNewMembers;
      }
      if (this.memberCount() >= MAX_PARTY_MEMBERS) {
        return partyIsFull;
      }
    }

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO memberships (member_id, member_email, name, joined_at) VALUES (?, ?, ?, ?)',
        member.id, member.email, displayName, Date.now(),
      );
      this.touch();
      if (member.email) {
        this.enqueue({ kind: 'user.sync', email: member.email });
        this.enqueue({ kind: 'user.setNameIfEmpty', email: member.email, name: displayName, memberId: member.id });
      }
    });
    await this.deliverUserUpdates();
    return { ok: true, view: this.buildView(party, member.id) };
  }

  /** Checks a joining session with the user's object on its own (`UserDO.check`). Null when it can't be reached. */
  private async checkSession(email: string, session: Session): Promise<boolean | null> {
    try {
      return Boolean(await this.env.USER.getByName(email).check(session));
    } catch (error) {
      console.warn('Unable to check the joining user', { error: String(error) });
      return null;
    }
  }

  /**
   * Updates the member's UserDO with the session check first, then stores the membership. Refuses the join when the
   * user can't be reached.
   */
  private async checkedJoin(party: PartyRow, member: Member & { email: string }, displayName: string, check: JoinCheck): Promise<PartyResult> {
    const session = { userId: member.id, ...check };
    let user: UserRecord | null;
    try {
      user = await this.env.USER.getByName(member.email).apply([
        { type: 'addParty', party: this.summary(party, member.id) },
        { type: 'setNameIfEmpty', name: displayName, userId: member.id },
      ], session);
    } catch (error) {
      console.warn('Unable to update the joining user', { error: String(error) });
      return tryAgain;
    }
    if (!user) {
      return notLoggedIn;
    }

    // Other requests may have reached the party while the user was being updated. The host may even have deleted it,
    // or deleted their account and with it the party.
    const current = this.liveParty();
    if (!current) {
      this.enqueue({ kind: 'user.partyPurged', email: member.email, slug: party.slug });
      await this.deliverUserUpdates();
      return fail('not_found', 'Party does not exist.', 'party');
    }
    if (!this.membership(member.id)) {
      const refusal = current.is_closed ? closedToNewMembers : this.memberCount() >= MAX_PARTY_MEMBERS ? partyIsFull : null;
      if (refusal) {
        // Too late (closed or filled up meanwhile): take the party back off the user's list.
        this.enqueue({ kind: 'user.sync', email: member.email });
        await this.deliverUserUpdates();
        return refusal;
      }
      this.sql.exec(
        'INSERT INTO memberships (member_id, member_email, name, joined_at) VALUES (?, ?, ?, ?)',
        member.id, member.email, displayName, Date.now(),
      );
      this.touch();
    }
    return { ok: true, view: this.buildView(current, member.id) };
  }

  private async leaveNow(userId: string): Promise<PartyResult> {
    const party = this.liveParty();
    if (!party) {
      return fail('not_found', 'Party does not exist.', 'party');
    }
    const membership = this.membership(userId);
    if (!membership) {
      return { ok: true, view: this.buildView(party, userId) };
    }
    // The open-party limit counts the parties in the host's list, so leaving would dodge it: hosts delete instead.
    if (party.host_id === userId) {
      return fail('conflict', "As the host, you can't leave your own party. Delete it instead, or close it once others have joined.", 'party');
    }
    if (party.is_closed) {
      return fail('conflict', 'Party is already at that stage when you cannot really run away... Sorry but you have to get the gift', 'party');
    }

    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM memberships WHERE member_id = ?', userId);
      this.touch();
      if (membership.member_email) {
        this.enqueue({ kind: 'user.sync', email: membership.member_email });
      }
    });
    await this.deliverUserUpdates();
    return { ok: true, view: this.buildView(party, userId) };
  }

  private async closeNow(userId: string): Promise<PartyResult> {
    const party = this.liveParty();
    if (!party) {
      return fail('not_found', 'Party does not exist.', 'party');
    }
    if (party.host_id !== userId) {
      return fail('forbidden', 'You must be the host to close the party.', 'party');
    }
    if (party.is_closed) {
      // Already drawn: a repeat gets the same draw. Nothing is drawn or mailed again.
      return { ok: true, view: this.buildView(party, userId) };
    }
    const members = this.sql.exec<MembershipRow>('SELECT * FROM memberships').toArray();
    if (members.length < 2) {
      return fail('conflict', 'You need at least two participants to close the party.', 'party');
    }

    const draws = santaShuffle(members, (a, b) => a.member_id === b.member_id);
    const closedAt = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const { src, target } of draws) {
        this.sql.exec(
          'UPDATE memberships SET target_id = ?, target_name = ? WHERE member_id = ?',
          target.member_id, target.name, src.member_id,
        );
      }
      this.sql.exec('UPDATE party SET is_closed = 1, closed_at = ?', closedAt);
      // Nobody can join a drawn party, so the invited addresses aren't needed any more.
      this.sql.exec('DELETE FROM invites');
      // Every member's party list shows the party as closed, and everyone gets the notification email.
      for (const member of members) {
        if (member.member_email) {
          this.enqueue({ kind: 'user.sync', email: member.member_email });
          this.enqueue({ kind: 'mail.partyNotification', email: member.member_email, partyName: party.name, slug: party.slug });
        }
      }
    });
    // The Party'o'meter is counted alongside: the draw doesn't wait for it.
    this.ctx.waitUntil(this.countRoll());
    // The host's list is updated before returning, so the closed party stops counting towards their open-party
    // limit right away. Other members and the emails follow on the alarm.
    const hostEmail = members.find(member => member.member_id === userId)?.member_email;
    await this.deliverHostNow(hostEmail);
    await this.deliverSoon();
    return { ok: true, view: this.buildView({ ...party, is_closed: 1, closed_at: closedAt }, userId) };
  }

  /**
   * Adds this party to the Party'o'meter (StatsDO), once: only the first draw gets here. If the counter can't be
   * reached, the roll goes uncounted. That's fine for a number on a page, and keeps the draw itself out of it: it
   * never waits for this, or fails because of it.
   */
  private async countRoll() {
    try {
      await this.env.STATS.getByName(STATS_NAME).rolled();
    } catch (error) {
      console.warn('Unable to count the roll', { error: String(error) });
    }
  }

  /**
   * Deletes an open party, whether or not anyone has joined; once the dice are rolled it can't be deleted. It leaves
   * every member's list but the host's, and its link stops working. The host can restore it within
   * RESTORE_WINDOW_MS; after that the alarm erases it for good.
   */
  private async deleteNow(userId: string): Promise<PartyResult> {
    const party = this.party();
    if (!party) {
      return fail('not_found', 'Party does not exist.', 'party');
    }
    if (party.deleted_at) {
      // Already deleted: the host gets it back as it is (a repeat), anyone else sees no party, as for a lookup.
      return party.host_id === userId && !this.restoreExpired(party)
        ? { ok: true, view: this.buildView(party, userId) }
        : fail('not_found', 'Party does not exist.', 'party');
    }
    if (party.host_id !== userId) {
      return fail('forbidden', 'You must be the host to delete the party.', 'party');
    }
    if (party.is_closed) {
      return fail('conflict', 'The dice have already been rolled, so this party can no longer be deleted.', 'party');
    }
    const deletedAt = Date.now();
    this.setDeleted(deletedAt);
    // The host's list shows it as deleted (and it stops counting towards their limit) before returning.
    await this.deliverHostNow(this.membership(userId)?.member_email);
    await this.deliverSoon();
    return { ok: true, view: this.buildView({ ...party, deleted_at: deletedAt }, userId) };
  }

  /**
   * Brings back a deleted party exactly as it was, for everyone. An open party counts towards the host's limit
   * again, so the caller holds a slot for it first and passes the reservation.
   */
  private async restoreNow(userId: string, reservation?: string): Promise<PartyResult> {
    const party = this.party();
    if (party && !party.deleted_at && party.host_id === userId) {
      // Not deleted (any more): a repeat, or a restore that raced another. Give back a slot held for it, if any.
      const hostEmail = this.membership(userId)?.member_email;
      if (reservation && hostEmail) {
        this.enqueue({ kind: 'user.sync', email: hostEmail, reservation });
        await this.deliverHostNow(hostEmail);
      }
      return { ok: true, view: this.buildView(party, userId) };
    }
    if (!party || !party.deleted_at || party.host_id !== userId) {
      return fail('not_found', 'There is no deleted party to restore.', 'party');
    }
    if (this.restoreExpired(party)) {
      return fail('conflict', 'This party was deleted more than a day ago and can no longer be restored.', 'party');
    }
    this.setDeleted(null, reservation);
    await this.deliverHostNow(this.membership(userId)?.member_email);
    await this.deliverSoon();
    return { ok: true, view: this.buildView({ ...party, deleted_at: null }, userId) };
  }

  /**
   * Marks the party deleted, restorable for `restoreFor` (or restored, which counts as activity), and queues an update
   * for every member's list.
   */
  private setDeleted(deletedAt: number | null, reservation?: string, restoreFor = RESTORE_WINDOW_MS) {
    const hostId = this.party()!.host_id;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('UPDATE party SET deleted_at = ?, restorable_until = ?', deletedAt, deletedAt === null ? null : deletedAt + restoreFor);
      if (deletedAt === null) {
        this.touch();
      }
      for (const member of this.sql.exec<MembershipRow>('SELECT * FROM memberships').toArray()) {
        if (member.member_email) {
          this.enqueue({
            kind: 'user.sync',
            email: member.member_email,
            ...(member.member_id === hostId && reservation ? { reservation } : {}),
          });
        }
      }
    });
  }

  /** Erases a party whose restore window has passed, leaving a tombstone so its code is never reused. */
  private purgeIfExpired() {
    const party = this.party();
    if (party && this.restoreExpired(party)) {
      this.erase(party);
    }
  }

  /**
   * Deletes an open party whose `prune_at` has passed: like the host's own delete, restorable for
   * PRUNED_RESTORE_WINDOW_MS, and the host gets an email. One already past it before AUTO_PRUNE_SINCE is erased at
   * once, with no email. Runs in the alarm, whose outbox run then delivers the list updates and the email.
   */
  private pruneIfDue() {
    const party = this.party();
    if (!party || party.is_closed || party.deleted_at || party.prune_at === null || party.prune_at > Date.now()) {
      return;
    }
    if (party.prune_at < AUTO_PRUNE_SINCE) {
      this.erase(party);
      return;
    }
    const deletedAt = Date.now();
    const hostEmail = this.membership(party.host_id)?.member_email;
    this.setDeleted(deletedAt, undefined, PRUNED_RESTORE_WINDOW_MS);
    if (hostEmail) {
      this.enqueue({ kind: 'mail.partyPruned', email: hostEmail, partyName: party.name, slug: party.slug, restorableUntil: deletedAt + PRUNED_RESTORE_WINDOW_MS });
    }
  }

  /**
   * Reminds the host that the party is due in about a day, once, when `remind_at` has passed: by email, through the
   * outbox. A party drawn or deleted by then gets no reminder (there's nothing left to do, or nobody to do it for).
   */
  private remindIfDue() {
    const party = this.party();
    if (!party || party.remind_at === null || party.remind_at > Date.now()) {
      return;
    }
    const hostEmail = this.membership(party.host_id)?.member_email;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('UPDATE party SET remind_at = NULL');
      if (!party.is_closed && !party.deleted_at && hostEmail) {
        this.enqueue({ kind: 'mail.partyDue', email: hostEmail, partyName: party.name, slug: party.slug, members: this.memberCount() });
      }
    });
  }

  /** Erases the party for good: its memberships (and with them every email) go, and a tombstone keeps its code. */
  private erase(party: PartyRow) {
    const hostEmail = this.membership(party.host_id)?.member_email;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM memberships');
      this.sql.exec('DELETE FROM party');
      this.sql.exec('INSERT OR IGNORE INTO cancelled (slug, cancelled_at) VALUES (?, ?)', party.slug, Date.now());
      if (hostEmail) {
        this.enqueue({ kind: 'user.partyPurged', email: hostEmail, slug: party.slug });
      }
    });
    this.disconnect(GONE);
  }

  /**
   * Delivers everything queued for the host right away, including changes waiting for a retry, so closing or
   * deleting frees their open-party slot before the mutation returns. If it fails, the alarm retries as usual.
   */
  private async deliverHostNow(email: string | null | undefined) {
    await this.runOutbox(message => message.kind.startsWith('user.') && message.email === email, true);
  }


  /**
   * Removes a user whose account is being deleted, and drops everything queued for their email:
   * - an open party they host is erased at once, whoever joined (even one they had deleted): its code is never handed
   *   out again, and the members get it removed from their lists through the outbox;
   * - an open party they joined is left;
   * - in a drawn party their membership stays, so the draw holds, but is anonymized: a new random id (also as the
   *   giver's target and as the host), no email. The names stay, so their Secret Santa still knows who to buy for.
   */
  private async forgetMemberNow(userId: string, email: string): Promise<ForgetMemberResult> {
    if (!this.hasSchema()) {
      return 'none';
    }
    const party = this.party();
    const membership = this.membership(userId);
    this.ensureSchema(); // parties created before cancelling existed have no `cancelled` table yet
    const result = this.ctx.storage.transactionSync((): ForgetMemberResult => {
      this.dropQueued(email);
      if (!party) {
        return 'none';
      }
      if (!party.is_closed && party.host_id === userId) {
        const others = this.sql
          .exec<{ member_email: string }>('SELECT member_email FROM memberships WHERE member_id != ? AND member_email IS NOT NULL', userId)
          .toArray();
        this.sql.exec('DELETE FROM memberships');
        this.sql.exec('DELETE FROM party');
        this.sql.exec('INSERT INTO cancelled (slug, cancelled_at) VALUES (?, ?)', party.slug, Date.now());
        for (const { member_email } of others) {
          this.enqueue({ kind: 'user.partyPurged', email: member_email, slug: party.slug });
        }
        return 'deleted';
      }
      if (!party.is_closed && membership) {
        this.sql.exec('DELETE FROM memberships WHERE member_id = ?', userId);
        return 'left';
      }
      if (party.is_closed && (membership || party.host_id === userId)) {
        const anonymous = newObjectId();
        this.sql.exec('UPDATE memberships SET member_id = ?, member_email = NULL WHERE member_id = ?', anonymous, userId);
        this.sql.exec('UPDATE memberships SET target_id = ? WHERE target_id = ?', anonymous, userId);
        this.sql.exec('UPDATE party SET host_id = ? WHERE host_id = ?', anonymous, userId);
        return 'anonymized';
      }
      return 'none';
    });
    if (result === 'deleted') {
      await this.deliverSoon();
    }
    return result;
  }

  /**
   * Moves a member to a new email. In a party not drawn yet, the membership and everything queued for the old email
   * move to the new one, so later updates reach the moved account. A drawn party keeps the old email: the member still
   * sees it, since membership goes by user id. Returns the party's summary for the member's list, or null when they
   * are not a member (or there is no party), or when the party is deleted and they are not its host (it is not in
   * their list; a restore reaches the new email).
   */
  changeMemberEmail(userId: string, oldEmail: string, newEmail: string): UserPartyRecord | null {
    const party = this.party();
    if (!party || !this.membership(userId)) {
      return null;
    }
    if (!party.is_closed) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('UPDATE memberships SET member_email = ? WHERE member_id = ?', newEmail, userId);
        this.outbox.readdress(oldEmail, newEmail);
      });
    }
    return party.deleted_at && party.host_id !== userId ? null : this.summary(party, userId);
  }

  /** Delivers a batch: one email, or all queued changes for one user in a single UserDO call. */
  private async deliver(messages: OutboxMessage[]) {
    const [first] = messages;
    if (first.kind === 'mail.partyInvite') {
      // Invites go to addresses that may never have asked for anything: they share the per-address limit with every
      // other email (a Rate Limiting binding, so nothing is stored for the address), and one over it is dropped, not
      // retried. A party deleted or drawn since then has nothing to join.
      const party = this.liveParty();
      if (!party || party.is_closed) {
        return;
      }
      // They also count against the limit on all emails together. Over it, the invite waits for the outbox's next try:
      // the host asked for it. Taken before the per-address limit, so a retry doesn't count against the address twice.
      if (!await takeAllMail(this.env)) {
        throw new RetryLater('Over the limit on all emails together');
      }
      if (!await takeAddressLimit(this.env, first.email)) {
        return;
      }
      return await sendMail(this.env, first.email, renderPartyInvite({
        hostName: first.hostName,
        party: { name: first.partyName, url: `${this.env.FRONTEND_URL}/p/${first.slug}/`, isProtected: first.isProtected },
        assetsUrl: this.env.PUBLIC_URL,
      }));
    }
    if (first.kind === 'mail.partyDue') {
      return await sendMail(this.env, first.email, renderPartyDue({
        party: { name: first.partyName, url: `${this.env.FRONTEND_URL}/p/${first.slug}/` },
        members: first.members,
        assetsUrl: this.env.PUBLIC_URL,
      }));
    }
    if (first.kind === 'mail.partyPruned') {
      return await sendMail(this.env, first.email, renderPartyPruned({
        party: { name: first.partyName, url: `${this.env.FRONTEND_URL}/p/${first.slug}/` },
        restorableUntil: first.restorableUntil,
        assetsUrl: this.env.PUBLIC_URL,
      }));
    }
    if (first.kind === 'mail.partyNotification') {
      return await sendMail(this.env, first.email, renderPartyNotification({
        party: { name: first.partyName, url: `${this.env.FRONTEND_URL}/p/${first.slug}/` },
        assetsUrl: this.env.PUBLIC_URL,
      }));
    }
    const updates: UserUpdate[] = [];
    let synced = false;
    for (const message of messages) {
      if (message.kind === 'user.setNameIfEmpty') {
        updates.push({ type: 'setNameIfEmpty', name: message.name, userId: message.memberId });
      } else if (message.kind === 'user.partyPurged') {
        synced = true;
        updates.push({ type: 'removeParty', slug: message.slug });
      } else if (!synced && this.party()) {
        synced = true;
        updates.push(this.memberUpdate(first.email));
      }
    }
    // Released after the party is in the list (same UserDO transaction), so the slot is never counted twice or not at all.
    for (const message of messages) {
      if (message.kind === 'user.sync' && message.reservation) {
        updates.push({ type: 'releaseHostSlot', reservation: message.reservation });
      }
    }
    // A sync queued for a party that has since been erased has nothing left to send.
    if (updates.length === 0) {
      return;
    }
    return await this.env.USER.getByName(first.email).apply(updates);
  }

  async alarm() {
    if (this.hasSchema()) {
      this.ensureSchema(); // parties created before tombstones existed have no `cancelled` table yet
      this.purgeIfExpired();
      this.pruneIfDue();
      this.remindIfDue();
    }
    await this.runOutbox(() => true);
  }

  /** Delivers due outbox messages that match `filter`, then sets the next alarm. */
  private async runOutbox(filter: (message: OutboxMessage) => boolean, skipRetryWait = false) {
    await this.outbox.process(filter, skipRetryWait);
    if (this.hasSchema()) {
      this.tidy();
    }
    const next = this.nextAlarm();
    if (next !== null) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  /**
   * When the alarm should next run: the earliest outbox retry, the end of a deleted party's restore window (it is
   * erased then), when the oldest invite is due to be deleted, when an open party is due to be pruned, or when its
   * host is due a reminder. Null when there's nothing to wait for.
   */
  private nextAlarm(): number | null {
    const retry = this.outbox.nextAttemptAt();
    const party = this.hasSchema() ? this.party() : null;
    const purge = party ? this.restorableUntil(party) : null;
    const prune = party && !party.is_closed && !party.deleted_at ? party.prune_at : null;
    const remind = party ? party.remind_at : null;
    const oldestInvite = this.hasSchema() ? this.sql.exec<{ at: number | null }>('SELECT MIN(invited_at) AS at FROM invites').one().at : null;
    const forget = oldestInvite === null ? null : oldestInvite + REINVITE_AFTER_MS;
    const next = [retry, purge, prune, remind, forget].filter((at): at is number => at !== null && at !== undefined);
    return next.length ? Math.max(Math.min(...next), Date.now()) : null;
  }

  /** Number of undelivered outbox messages. Used by tests. */
  pendingOutbox(): number {
    return this.outbox.pending();
  }
}
