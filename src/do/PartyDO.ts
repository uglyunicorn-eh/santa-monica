import { DurableObject } from 'cloudflare:workers';

import { Env } from 'src/env';
import { isPermanentMailError, renderPartyNotification, sendMail } from 'src/mail';
import santaShuffle from 'src/utils/santaShuffle';

import { CreatePartyInput, Member, PartyResult, PartySnapshot, PartyView, UserPartyRecord } from './types';

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

type OutboxMessage =
  | { kind: 'user.addParty'; email: string; party: UserPartyRecord }
  | { kind: 'user.removeParty'; email: string; slug: string }
  | { kind: 'user.setName'; email: string; name: string }
  | { kind: 'mail.partyNotification'; email: string; partyName: string; slug: string };

type OutboxRow = { id: number; payload: string; attempts: number };

const MAX_ATTEMPTS = 15;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

const fail = (fieldName: string | null, message: string): PartyResult => ({ ok: false, error: { fieldName, message } });

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

  private partyRecord(party: PartyRow): UserPartyRecord {
    return { slug: party.slug, name: party.name, createdAt: party.created_at };
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
      ? { id: membership.target_id, name: membership.target_name ?? '' }
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
    if (this.party()) {
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
        this.enqueue({ kind: 'user.addParty', email: input.host.email, party: this.partyRecord(party) });
      }
    });
    await this.deliverUserUpdates();
    return { ok: true, view: this.buildView(party, input.host.id) };
  }

  async join(member: Member, name: string, password: string | null): Promise<PartyResult> {
    const party = this.party();
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
        this.enqueue({ kind: 'user.addParty', email: member.email, party: this.partyRecord(party) });
        this.enqueue({ kind: 'user.setName', email: member.email, name: displayName });
      }
    });
    await this.deliverUserUpdates();
    return { ok: true, view: this.buildView(party, member.id) };
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
    if (party.is_closed) {
      return fail('party', 'Party is already at that stage when you cannot really run away... Sorry but you have to get the gift');
    }

    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM memberships WHERE member_id = ?', userId);
      if (membership.member_email) {
        this.enqueue({ kind: 'user.removeParty', email: membership.member_email, slug: party.slug });
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
      for (const member of members) {
        if (member.member_email) {
          this.enqueue({ kind: 'mail.partyNotification', email: member.member_email, partyName: party.name, slug: party.slug });
        }
      }
    });
    await this.deliverSoon();
    return { ok: true, view: this.buildView({ ...party, is_closed: 1 }, userId) };
  }

  /** Replaces the whole party with the snapshot. Used by the Mongo import, safe to re-run. */
  importParty(snapshot: PartySnapshot): { memberships: number } {
    this.ensureSchema();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM party');
      this.sql.exec('DELETE FROM memberships');
      this.sql.exec(
        'INSERT INTO party (id, slug, name, password, host_id, is_closed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        snapshot.id, snapshot.slug, snapshot.name, snapshot.password, snapshot.hostId, snapshot.isClosed ? 1 : 0, snapshot.createdAt,
      );
      for (const m of snapshot.members) {
        this.sql.exec(
          'INSERT INTO memberships (member_id, member_email, name, target_id, target_name, joined_at) VALUES (?, ?, ?, ?, ?, ?)',
          m.id, m.email, m.name, m.targetId, m.targetName, m.joinedAt,
        );
      }
    });
    return { memberships: this.memberCount() };
  }

  private async deliver(message: OutboxMessage) {
    switch (message.kind) {
      case 'user.addParty':
        return await this.env.USER.getByName(message.email).addParty(message.party);
      case 'user.removeParty':
        return await this.env.USER.getByName(message.email).removeParty(message.slug);
      case 'user.setName':
        return await this.env.USER.getByName(message.email).setName(message.name);
      case 'mail.partyNotification':
        return await sendMail(this.env, message.email, renderPartyNotification({
          party: { name: message.partyName, url: `${baseUrl}/p/${message.slug}/` },
          assetsUrl: this.env.PUBLIC_URL,
        }));
    }
  }

  async alarm() {
    await this.runOutbox(() => true);
  }

  private runOutbox(filter: (message: OutboxMessage) => boolean): Promise<void> {
    const run = this.outboxRun.then(() => this.processOutbox(filter));
    this.outboxRun = run.catch(() => undefined);
    return run;
  }

  private async processOutbox(filter: (message: OutboxMessage) => boolean) {
    if (!this.hasSchema()) {
      return;
    }
    const now = Date.now();
    const rows = this.sql
      .exec<OutboxRow & { next_attempt_at: number }>('SELECT id, payload, attempts, next_attempt_at FROM outbox ORDER BY id')
      .toArray();

    // Messages for the same user are delivered in order: while an earlier one is waiting for a retry, later ones wait too.
    const blocked = new Set<string>();
    for (const row of rows) {
      const message = JSON.parse(row.payload) as OutboxMessage;
      const orderKey = message.kind.startsWith('user.') ? message.email : `mail:${row.id}`;
      if (blocked.has(orderKey)) {
        continue;
      }
      if (row.next_attempt_at > now) {
        blocked.add(orderKey);
        continue;
      }
      if (!filter(message)) {
        continue;
      }
      try {
        await this.deliver(message);
        this.sql.exec('DELETE FROM outbox WHERE id = ?', row.id);
      } catch (error) {
        const attempts = row.attempts + 1;
        if (isPermanentMailError(error) || attempts >= MAX_ATTEMPTS) {
          console.error('Dropping outbox message', { kind: message.kind, attempts, error: String(error) });
          this.sql.exec('DELETE FROM outbox WHERE id = ?', row.id);
          continue;
        }
        console.warn('Outbox delivery failed, will retry', { kind: message.kind, attempts, error: String(error) });
        blocked.add(orderKey);
        this.sql.exec(
          'UPDATE outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?',
          attempts, Date.now() + Math.min(1000 * 2 ** attempts, MAX_BACKOFF_MS), row.id,
        );
      }
    }

    const next = this.sql.exec<{ at: number | null }>('SELECT MIN(next_attempt_at) AS at FROM outbox').one().at;
    if (next !== null) {
      await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
    }
  }

  /** Number of undelivered outbox messages. Used by tests and the import endpoint. */
  pendingOutbox(): number {
    if (!this.hasSchema()) {
      return 0;
    }
    return this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox').one().n;
  }
}
