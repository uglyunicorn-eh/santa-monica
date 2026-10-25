import { DurableObject } from 'cloudflare:workers';

import { Env } from 'src/env';
import { isPermanentMailError, renderPartyNotification, sendMail } from 'src/mail';
import santaShuffle from 'src/utils/santaShuffle';

import { CreatePartyInput, Member, PartyResult, PartyView, UserUpdate } from './types';

import { baseUrl } from 'src/config.json';

type PartyRow = {
  id: string;
  slug: string;
  name: string;
  password: string | null;
  host_id: string;
  is_closed: number;
  created_at: number;
  deleted_at: number | null;
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
// delivery time, so it is always current and safe to repeat. user.addParty / user.removeParty are older forms of it.
// A sync from creating a party carries the host's slot reservation (see UserDO.startHosting), released on delivery.
type OutboxMessage =
  | { kind: 'user.sync'; email: string; reservation?: string }
  | { kind: 'user.addParty' | 'user.removeParty'; email: string }
  | { kind: 'user.setName'; email: string; name: string }
  // Sent when the party is erased for good: the party row is gone, so the slug travels with the message.
  // (user.partyCancelled is the earlier name.)
  | { kind: 'user.partyPurged' | 'user.partyCancelled'; email: string; slug: string }
  | { kind: 'mail.partyNotification'; email: string; partyName: string; slug: string };

type OutboxRow = { id: number; payload: string; attempts: number; next_attempt_at: number };

type OutboxBatch = { key: string; rows: OutboxRow[]; messages: OutboxMessage[] };

/** How long a deleted party can be restored. After that it is erased for good. */
export const RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000;

const MAX_ATTEMPTS = 15;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

const fail = (fieldName: string | null, message: string) => ({ ok: false as const, error: { fieldName, message } });

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
  // Outbox runs (inline and from the alarm) are chained so a message is never delivered twice at the same time.
  private outboxRun: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  // The schema is created on the first write only, so looking up an unknown code does not store anything.
  private hasSchema(): boolean {
    if (!this.schemaReady && this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'party'").toArray().length) {
      this.schemaReady = true;
      this.migrate();
    }
    return this.schemaReady;
  }

  /** Parties created before deletion existed get the deleted_at column. */
  private migrate() {
    const columns = this.sql.exec<{ name: string }>('PRAGMA table_info(party)').toArray().map(c => c.name);
    if (!columns.includes('deleted_at')) {
      this.sql.exec('ALTER TABLE party ADD COLUMN deleted_at INTEGER');
    }
  }

  private ensureSchema() {
    this.schemaReady = true;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS party (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        password TEXT,
        host_id TEXT NOT NULL,
        is_closed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
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
      -- A row here means the party was cancelled: its code is never handed out again.
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
    this.migrate(); // tables that existed before this code may lack newer columns
  }

  private party(): PartyRow | null {
    if (!this.hasSchema()) {
      return null;
    }
    return this.sql.exec<PartyRow>('SELECT * FROM party LIMIT 1').toArray()[0] ?? null;
  }

  private membership(userId: string): MembershipRow | null {
    return this.sql.exec<MembershipRow>('SELECT * FROM memberships WHERE member_id = ?', userId).toArray()[0] ?? null;
  }

  private memberCount(): number {
    return this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM memberships').one().n;
  }

  private enqueue(message: OutboxMessage) {
    this.sql.exec('INSERT INTO outbox (payload, next_attempt_at) VALUES (?, ?)', JSON.stringify(message), Date.now());
  }

  private async deliverSoon() {
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** Delivers queued user updates now, so the caller's party list and name are current when the mutation returns. */
  private async deliverUserUpdates() {
    await this.runOutbox(message => message.kind.startsWith('user.'));
  }

  /** The party as a member sees it in their list, or its removal if they are no longer a member. */
  private memberUpdate(email: string): UserUpdate {
    const party = this.party()!;
    const membership = this.sql
      .exec<{ member_id: string }>('SELECT member_id FROM memberships WHERE member_email = ?', email)
      .toArray()[0];
    const isHost = membership?.member_id === party.host_id;
    // A deleted party leaves everyone's list but the host's, where it waits to be restored.
    if (!membership || (party.deleted_at && !isHost)) {
      return { type: 'removeParty', slug: party.slug };
    }
    return {
      type: 'addParty',
      party: {
        slug: party.slug,
        name: party.name,
        createdAt: party.created_at,
        isHost,
        isProtected: Boolean(party.password),
        isClosed: Boolean(party.is_closed),
        deletedAt: party.deleted_at,
      },
    };
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
      deletedAt: party.deleted_at,
      participantCount: isJoined ? this.memberCount() : null,
      participants,
      target,
    };
  }

  /** The party as this user sees it. A deleted party is visible only to its host, until it can't be restored. */
  view(userId?: string): PartyView | null {
    const party = this.party();
    if (!party || (party.deleted_at && (party.host_id !== userId || this.restoreExpired(party)))) {
      return null;
    }
    return this.buildView(party, userId);
  }

  private restoreExpired(party: PartyRow) {
    return Boolean(party.deleted_at && Date.now() >= party.deleted_at + RESTORE_WINDOW_MS);
  }

  /** The party unless it was deleted: joining, leaving and closing treat a deleted party as gone. */
  private liveParty(): PartyRow | null {
    const party = this.party();
    return party && !party.deleted_at ? party : null;
  }

  /** Creates the party. Returns `conflict` when the slug is already taken, so the caller can pick another one. */
  async create(input: CreatePartyInput & { id: string; slug: string }): Promise<PartyResult | { ok: false; conflict: true }> {
    this.ensureSchema();
    if (this.party() || this.sql.exec('SELECT 1 FROM cancelled LIMIT 1').toArray().length) {
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
      deleted_at: null,
    };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO party (id, slug, name, password, host_id, is_closed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
        party.id, party.slug, party.name, party.password, party.host_id, party.created_at,
      );
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

  async join(member: Member, name: string, password: string | null): Promise<PartyResult> {
    const party = this.liveParty();
    if (!party) {
      return fail('party', 'Party does not exist.');
    }
    if (this.membership(member.id)) {
      return { ok: true, view: this.buildView(party, member.id) };
    }
    if (party.is_closed) {
      return fail('party', 'Party is already packed. Sorry, we cannot accept a new participant...');
    }
    if ((party.password || '').toUpperCase() !== (password || '').toUpperCase()) {
      return fail('password', "Hmm... Seems you've got a wrong secret phrase. Please try a different one or ask your friend for a hint.");
    }
    const displayName = name || member.name;
    if (!displayName) {
      return fail('name', 'We were unable to get your name.');
    }

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO memberships (member_id, member_email, name, joined_at) VALUES (?, ?, ?, ?)',
        member.id, member.email, displayName, Date.now(),
      );
      if (member.email) {
        this.enqueue({ kind: 'user.sync', email: member.email });
        this.enqueue({ kind: 'user.setName', email: member.email, name: displayName });
      }
    });
    await this.deliverUserUpdates();
    return { ok: true, view: this.buildView(party, member.id) };
  }

  async leave(userId: string): Promise<PartyResult> {
    const party = this.liveParty();
    if (!party) {
      return fail('party', 'Party does not exist.');
    }
    const membership = this.membership(userId);
    if (!membership) {
      return { ok: true, view: this.buildView(party, userId) };
    }
    // The open-party limit counts the parties in the host's list, so leaving would dodge it: hosts delete instead.
    if (party.host_id === userId) {
      return fail('party', "As the host, you can't leave your own party. Delete it instead, or close it once others have joined.");
    }
    if (party.is_closed) {
      return fail('party', 'Party is already at that stage when you cannot really run away... Sorry but you have to get the gift');
    }

    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM memberships WHERE member_id = ?', userId);
      if (membership.member_email) {
        this.enqueue({ kind: 'user.sync', email: membership.member_email });
      }
    });
    await this.deliverUserUpdates();
    return { ok: true, view: this.buildView(party, userId) };
  }

  async close(userId: string): Promise<PartyResult> {
    const party = this.liveParty();
    if (!party) {
      return fail('party', 'Party does not exist.');
    }
    if (party.host_id !== userId) {
      return fail('party', 'You must be the host to close the party.');
    }
    if (party.is_closed) {
      return fail('party', 'Party is already closed.');
    }
    const members = this.sql.exec<MembershipRow>('SELECT * FROM memberships').toArray();
    if (members.length < 2) {
      return fail('party', 'You need at least two participants to close the party.');
    }

    const draws = santaShuffle(members, (a, b) => a.member_id === b.member_id);
    this.ctx.storage.transactionSync(() => {
      for (const { src, target } of draws) {
        this.sql.exec(
          'UPDATE memberships SET target_id = ?, target_name = ? WHERE member_id = ?',
          target.member_id, target.name, src.member_id,
        );
      }
      this.sql.exec('UPDATE party SET is_closed = 1');
      // Every member's party list shows the party as closed, and everyone gets the notification email.
      for (const member of members) {
        if (member.member_email) {
          this.enqueue({ kind: 'user.sync', email: member.member_email });
          this.enqueue({ kind: 'mail.partyNotification', email: member.member_email, partyName: party.name, slug: party.slug });
        }
      }
    });
    // The host's list is updated before returning, so the closed party stops counting towards their open-party
    // limit right away. Other members and the emails follow on the alarm.
    const hostEmail = members.find(member => member.member_id === userId)?.member_email;
    await this.deliverHostNow(hostEmail);
    await this.deliverSoon();
    return { ok: true, view: this.buildView({ ...party, is_closed: 1 }, userId) };
  }

  /**
   * Deletes the party, whether or not anyone has joined: it leaves every member's list but the host's, and its link
   * stops working. The host can restore it within RESTORE_WINDOW_MS; after that the alarm erases it for good.
   */
  async delete(userId: string): Promise<PartyResult> {
    const party = this.liveParty();
    if (!party) {
      return fail('party', 'Party does not exist.');
    }
    if (party.host_id !== userId) {
      return fail('party', 'You must be the host to delete the party.');
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
  async restore(userId: string, reservation?: string): Promise<PartyResult> {
    const party = this.party();
    if (!party || !party.deleted_at || party.host_id !== userId) {
      return fail('party', 'There is no deleted party to restore.');
    }
    if (this.restoreExpired(party)) {
      return fail('party', 'This party was deleted more than a day ago and can no longer be restored.');
    }
    this.setDeleted(null, reservation);
    await this.deliverHostNow(this.membership(userId)?.member_email);
    await this.deliverSoon();
    return { ok: true, view: this.buildView({ ...party, deleted_at: null }, userId) };
  }

  /** Marks the party deleted (or restored) and queues an update for every member's list. */
  private setDeleted(deletedAt: number | null, reservation?: string) {
    const hostId = this.party()!.host_id;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('UPDATE party SET deleted_at = ?', deletedAt);
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
    if (!party || !this.restoreExpired(party)) {
      return;
    }
    const hostEmail = this.membership(party.host_id)?.member_email;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM memberships');
      this.sql.exec('DELETE FROM party');
      this.sql.exec('INSERT OR IGNORE INTO cancelled (slug, cancelled_at) VALUES (?, ?)', party.slug, Date.now());
      if (hostEmail) {
        this.enqueue({ kind: 'user.partyPurged', email: hostEmail, slug: party.slug });
      }
    });
  }

  /**
   * Delivers everything queued for the host right away, including changes waiting for a retry, so closing or
   * cancelling frees their open-party slot before the mutation returns. If it fails, the alarm retries as usual.
   */
  private async deliverHostNow(email: string | null | undefined) {
    await this.runOutbox(message => message.kind.startsWith('user.') && message.email === email, true);
  }


  /** Delivers a batch: one email, or all queued changes for one user in a single UserDO call. */
  private async deliver({ messages }: OutboxBatch) {
    const [first] = messages;
    if (first.kind === 'mail.partyNotification') {
      return await sendMail(this.env, first.email, renderPartyNotification({
        party: { name: first.partyName, url: `${baseUrl}/p/${first.slug}/` },
        assetsUrl: this.env.PUBLIC_URL,
      }));
    }
    const updates: UserUpdate[] = [];
    let synced = false;
    for (const message of messages) {
      if (message.kind === 'user.setName') {
        updates.push({ type: 'setName', name: message.name });
      } else if (message.kind === 'user.partyPurged' || message.kind === 'user.partyCancelled') {
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
    }
    await this.runOutbox(() => true);
  }

  private runOutbox(filter: (message: OutboxMessage) => boolean, skipRetryWait = false): Promise<void> {
    const run = this.outboxRun.then(() => this.processOutbox(filter, skipRetryWait));
    this.outboxRun = run.catch(() => undefined);
    return run;
  }

  private async processOutbox(filter: (message: OutboxMessage) => boolean, skipRetryWait: boolean) {
    if (!this.hasSchema()) {
      return;
    }
    const now = Date.now();
    const rows = this.sql
      .exec<OutboxRow>('SELECT id, payload, attempts, next_attempt_at FROM outbox ORDER BY id')
      .toArray();

    // One batch per user (all their due changes, in order) and one per email. While an earlier change for a user is
    // waiting for a retry, later ones wait too, so a user never sees changes out of order. With skipRetryWait, matching
    // messages go now even if waiting, still together and in order.
    const batches = new Map<string, OutboxBatch>();
    const blocked = new Set<string>();
    for (const row of rows) {
      const message = JSON.parse(row.payload) as OutboxMessage;
      const key = message.kind.startsWith('user.') ? message.email : `mail:${row.id}`;
      const forced = skipRetryWait && filter(message);
      if (blocked.has(key) && !forced) {
        continue;
      }
      if (row.next_attempt_at > now && !forced) {
        blocked.add(key);
        continue;
      }
      if (!filter(message)) {
        continue;
      }
      const batch = batches.get(key) ?? { key, rows: [], messages: [] };
      batch.rows.push(row);
      batch.messages.push(message);
      batches.set(key, batch);
    }

    await Promise.all([...batches.values()].map(async batch => {
      const ids = batch.rows.map(row => row.id);
      try {
        await this.deliver(batch);
        this.sql.exec(`DELETE FROM outbox WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
      } catch (error) {
        const attempts = batch.rows[0].attempts + 1;
        const kind = batch.messages[0].kind;
        if (isPermanentMailError(error) || attempts >= MAX_ATTEMPTS) {
          console.error('Dropping outbox messages', { kind, count: ids.length, attempts, error: String(error) });
          this.sql.exec(`DELETE FROM outbox WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
          return;
        }
        console.warn('Outbox delivery failed, will retry', { kind, count: ids.length, attempts, error: String(error) });
        const retryAt = Date.now() + Math.min(1000 * 2 ** attempts, MAX_BACKOFF_MS);
        this.sql.exec(
          `UPDATE outbox SET attempts = ?, next_attempt_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
          attempts, retryAt, ...ids,
        );
      }
    }));

    // The next alarm: the earliest retry, or when a deleted party's restore window ends (it is erased then).
    const retry = this.sql.exec<{ at: number | null }>('SELECT MIN(next_attempt_at) AS at FROM outbox').one().at;
    const deletedAt = this.party()?.deleted_at;
    const purge = deletedAt ? deletedAt + RESTORE_WINDOW_MS : null;
    const next = [retry, purge].filter((at): at is number => at !== null);
    if (next.length) {
      await this.ctx.storage.setAlarm(Math.max(Math.min(...next), Date.now()));
    }
  }

  /** Number of undelivered outbox messages. Used by tests. */
  pendingOutbox(): number {
    if (!this.hasSchema()) {
      return 0;
    }
    return this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox').one().n;
  }
}
