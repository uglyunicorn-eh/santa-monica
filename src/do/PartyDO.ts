import { DurableObject } from 'cloudflare:workers';

import { Env } from 'src/env';
import { isPermanentMailError, renderPartyNotification, sendMail } from 'src/mail';
import santaShuffle from 'src/utils/santaShuffle';
import { Session, sessionMatches } from 'src/utils/session';

import { newObjectId } from 'src/utils/ids';

import { CancelResult, CreatePartyInput, ForgetMemberResult, Member, PartyResult, PartyView, UserPartyRecord, UserRecord, UserUpdate } from './types';

import { baseUrl } from 'src/config.json';

type PartyRow = {
  id: string;
  slug: string;
  name: string;
  password: string | null;
  host_id: string;
  is_closed: number;
  created_at: number;
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
// user.setNameIfEmpty gives a new member's profile the name they joined with, unless they already have one.
// user.setName is its older form, queued before joining stopped overwriting profile names; it is delivered the same way.
type OutboxMessage =
  | { kind: 'user.sync'; email: string; reservation?: string }
  | { kind: 'user.addParty' | 'user.removeParty'; email: string }
  | { kind: 'user.setNameIfEmpty' | 'user.setName'; email: string; name: string; memberId?: string }
  // Sent when the party is cancelled: the party row is gone, so the slug travels with the message.
  | { kind: 'user.partyCancelled'; email: string; slug: string }
  | { kind: 'mail.partyNotification'; email: string; partyName: string; slug: string };

type OutboxRow = { id: number; payload: string; attempts: number; next_attempt_at: number };

type OutboxBatch = { key: string; rows: OutboxRow[]; messages: OutboxMessage[] };

/** The joining session's token version, checked against the user's record (see `Session`). */
export type JoinCheck = Pick<Session, 'tokenVersion'>;

const MAX_ATTEMPTS = 15;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

const fail = (fieldName: string | null, message: string) => ({ ok: false as const, error: { fieldName, message } });

const closedToNewMembers = fail('party', 'Party is already packed. Sorry, we cannot accept a new participant...');

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
    this.schemaReady ||= this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'party'").toArray().length > 0;
    return this.schemaReady;
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
        created_at INTEGER NOT NULL
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
  }

  private party(): PartyRow | null {
    if (!this.hasSchema()) {
      return null;
    }
    return this.sql.exec<PartyRow>('SELECT * FROM party LIMIT 1').toArray()[0] ?? null;
  }

  /** Drops queued messages (user updates and mail) addressed to this email. */
  private dropQueued(email: string) {
    this.sql.exec("DELETE FROM outbox WHERE json_extract(payload, '$.email') = ?", email);
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

  /** Whether the outbox still holds changes for this user (waiting for a retry, or being delivered). */
  private hasQueuedUserUpdates(email: string): boolean {
    return this.sql.exec(
      "SELECT 1 FROM outbox WHERE json_extract(payload, '$.kind') LIKE 'user.%' AND json_extract(payload, '$.email') = ? LIMIT 1", email,
    ).toArray().length > 0;
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
    };
  }

  /** The party as a member sees it in their list, or its removal if they are no longer a member. */
  private memberUpdate(email: string): UserUpdate {
    const party = this.party()!;
    const membership = this.sql
      .exec<{ member_id: string }>('SELECT member_id FROM memberships WHERE member_email = ?', email)
      .toArray()[0];
    if (!membership) {
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
      participantCount: isJoined ? this.memberCount() : null,
      participants,
      target,
    };
  }

  view(userId?: string): PartyView | null {
    const party = this.party();
    return party ? this.buildView(party, userId) : null;
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

  /**
   * Adds a member. With `check`, the joining session is verified in the call that updates the member's UserDO anyway
   * (no extra call), before the membership is stored: the UserDO gets the party summary and the name together with the
   * session, and writes nothing if the account was deleted or the token revoked. Then the join fails and nothing was
   * stored anywhere. If the user can't be reached, or older changes for them are still queued (sending this one first
   * would reorder them), the join goes through the outbox unchecked, as joins without `check` do.
   */
  async join(member: Member, name: string, password: string | null, check?: JoinCheck): Promise<PartyResult> {
    const party = this.party();
    if (!party) {
      return fail('party', 'Party does not exist.');
    }
    if (this.membership(member.id)) {
      return { ok: true, view: this.buildView(party, member.id) };
    }
    if (party.is_closed) {
      return closedToNewMembers;
    }
    if ((party.password || '').toUpperCase() !== (password || '').toUpperCase()) {
      return fail('password', "Hmm... Seems you've got a wrong secret phrase. Please try a different one or ask your friend for a hint.");
    }
    const displayName = name || member.name;
    if (!displayName) {
      return fail('name', 'We were unable to get your name.');
    }

    if (check && member.email && !this.hasQueuedUserUpdates(member.email)) {
      const checked = await this.checkedJoin(party, { ...member, email: member.email }, displayName, check);
      if (checked) {
        return checked;
      }
    }

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO memberships (member_id, member_email, name, joined_at) VALUES (?, ?, ?, ?)',
        member.id, member.email, displayName, Date.now(),
      );
      if (member.email) {
        this.enqueue({ kind: 'user.sync', email: member.email });
        this.enqueue({ kind: 'user.setNameIfEmpty', email: member.email, name: displayName, memberId: member.id });
      }
    });
    await this.deliverUserUpdates();
    return { ok: true, view: this.buildView(party, member.id) };
  }

  /**
   * Updates the member's UserDO with the session check first, then stores the membership. Returns undefined when the
   * user couldn't be reached, so the caller falls back to the outbox.
   */
  private async checkedJoin(party: PartyRow, member: Member & { email: string }, displayName: string, check: JoinCheck): Promise<PartyResult | undefined> {
    const session = { userId: member.id, tokenVersion: check.tokenVersion };
    let user: UserRecord | null;
    try {
      user = await this.env.USER.getByName(member.email).apply([
        { type: 'addParty', party: this.summary(party, member.id) },
        { type: 'setNameIfEmpty', name: displayName, userId: member.id },
      ], session);
    } catch (error) {
      console.warn('Unable to update the joining user, joining through the outbox', { error: String(error) });
      return undefined;
    }
    if (!sessionMatches(user, session)) {
      return fail(null, 'You must be logged in before joining the party.');
    }

    // Other requests may have reached the party while the user was being updated. The host may even have cancelled it,
    // or deleted their account and with it the party.
    const current = this.party();
    if (!current) {
      this.enqueue({ kind: 'user.partyCancelled', email: member.email, slug: party.slug });
      await this.deliverUserUpdates();
      return fail('party', 'Party does not exist.');
    }
    if (!this.membership(member.id)) {
      if (current.is_closed) {
        // Too late: take the party back off the user's list.
        this.enqueue({ kind: 'user.sync', email: member.email });
        await this.deliverUserUpdates();
        return closedToNewMembers;
      }
      this.sql.exec(
        'INSERT INTO memberships (member_id, member_email, name, joined_at) VALUES (?, ?, ?, ?)',
        member.id, member.email, displayName, Date.now(),
      );
    }
    return { ok: true, view: this.buildView(current, member.id) };
  }

  async leave(userId: string): Promise<PartyResult> {
    const party = this.party();
    if (!party) {
      return fail('party', 'Party does not exist.');
    }
    const membership = this.membership(userId);
    if (!membership) {
      return { ok: true, view: this.buildView(party, userId) };
    }
    // The open-party limit counts the parties in the host's list, so leaving would dodge it: hosts cancel instead.
    if (party.host_id === userId) {
      return fail('party', "As the host, you can't leave your own party. Cancel it instead, or close it once others have joined.");
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
    const party = this.party();
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
   * Deletes an open party nobody else has joined, so a host can take back a party (and its slot in their open-party
   * limit) when no one came. The host's list is updated before returning.
   */
  async cancel(userId: string): Promise<CancelResult> {
    const party = this.party();
    if (!party) {
      return fail('party', 'Party does not exist.');
    }
    if (party.host_id !== userId) {
      return fail('party', 'You must be the host to cancel the party.');
    }
    if (party.is_closed) {
      return fail('party', 'Party is already closed.');
    }
    const others = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM memberships WHERE member_id != ?', userId).one().n;
    if (others > 0) {
      return fail('party', 'Someone has already joined this party, so it can no longer be cancelled.');
    }

    const hostEmail = this.membership(userId)?.member_email;
    this.ensureSchema(); // parties created before tombstones existed have no `cancelled` table yet
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM memberships');
      this.sql.exec('DELETE FROM party');
      this.sql.exec('INSERT INTO cancelled (slug, cancelled_at) VALUES (?, ?)', party.slug, Date.now());
      if (hostEmail) {
        this.enqueue({ kind: 'user.partyCancelled', email: hostEmail, slug: party.slug });
      }
    });
    await this.deliverHostNow(hostEmail);
    return { ok: true };
  }

  /**
   * Delivers everything queued for the host right away, including changes waiting for a retry, so closing or
   * cancelling frees their open-party slot before the mutation returns. If it fails, the alarm retries as usual.
   */
  private async deliverHostNow(email: string | null | undefined) {
    await this.runOutbox(message => message.kind.startsWith('user.') && message.email === email, true);
  }


  /**
   * Removes a user whose account is being deleted, and drops everything queued for their email:
   * - an open party they host is deleted like a cancelled one (see `cancel`), whoever joined: it is gone at once, its
   *   code is never handed out again, and the members get it removed from their lists through the outbox;
   * - an open party they joined is left;
   * - in a drawn party their membership stays, so the draw holds, but is anonymized: a new random id (also as the
   *   giver's target and as the host), no email. The names stay, so their Secret Santa still knows who to buy for.
   */
  async forgetMember(userId: string, email: string): Promise<ForgetMemberResult> {
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
          this.enqueue({ kind: 'user.partyCancelled', email: member_email, slug: party.slug });
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
   * are not a member (or there is no party).
   */
  changeMemberEmail(userId: string, oldEmail: string, newEmail: string): UserPartyRecord | null {
    const party = this.party();
    if (!party || !this.membership(userId)) {
      return null;
    }
    if (!party.is_closed) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('UPDATE memberships SET member_email = ? WHERE member_id = ?', newEmail, userId);
        this.sql.exec(
          "UPDATE outbox SET payload = json_set(payload, '$.email', ?) WHERE json_extract(payload, '$.email') = ?", newEmail, oldEmail,
        );
      });
    }
    return this.summary(party, userId);
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
      if (message.kind === 'user.setNameIfEmpty' || message.kind === 'user.setName') {
        updates.push({ type: 'setNameIfEmpty', name: message.name, userId: message.memberId });
      } else if (message.kind === 'user.partyCancelled') {
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
    // A sync queued for a party that has since been cancelled has nothing left to send.
    if (updates.length === 0) {
      return;
    }
    return await this.env.USER.getByName(first.email).apply(updates);
  }

  async alarm() {
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

    const next = this.sql.exec<{ at: number | null }>('SELECT MIN(next_attempt_at) AS at FROM outbox').one().at;
    if (next !== null) {
      await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
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
