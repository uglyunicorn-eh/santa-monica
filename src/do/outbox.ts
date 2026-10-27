import { isPermanentMailError } from 'src/mail';

/** A queued message: `user.*` messages update a user's `UserDO`; anything else is an email. */
export type OutboxMessageBase = { kind: string; email: string };

type OutboxRow = { id: number; payload: string; attempts: number; next_attempt_at: number };

/** Messages dropped after this many failed deliveries (with backoff, that is about a day of retrying). */
export const MAX_ATTEMPTS = 15;

/**
 * Thrown by a delivery that was held back on purpose (an email over the limit on all emails together), not one that
 * failed. It's retried the same way, but not logged as a failure; only dropping it, at the end, is logged.
 */
export class RetryLater extends Error {}
const MAX_BACKOFF_MS = 60 * 60 * 1000;

/**
 * A transactional outbox in a Durable Object's SQLite storage (the `outbox` table). Messages are added in the same
 * transaction as the change they report, then delivered with retries:
 *
 * - All due `user.*` messages for one email go out together, in order, in one `deliver` call; each email message
 *   goes out on its own.
 * - While a user's earlier message waits for a retry, their later ones wait too, so a user never sees changes out of
 *   order.
 * - A failed delivery is retried with exponential backoff (up to an hour), and dropped after MAX_ATTEMPTS or on a
 *   permanent mail error.
 * - Runs are chained, so a message is never delivered twice at the same time.
 */
export class Outbox<M extends OutboxMessageBase> {
  private run: Promise<void> = Promise.resolve();

  constructor(
    private sql: SqlStorage,
    /** Whether the table exists yet (a Durable Object that never stored anything has none). */
    private ready: () => boolean,
    private deliver: (messages: M[]) => Promise<unknown>,
  ) {}

  add(message: M): void {
    this.sql.exec('INSERT INTO outbox (payload, next_attempt_at) VALUES (?, ?)', JSON.stringify(message), Date.now());
  }

  /** Drops every queued message (user updates and mail) addressed to this email. */
  drop(email: string): void {
    this.sql.exec("DELETE FROM outbox WHERE json_extract(payload, '$.email') = ?", email);
  }

  /** Readdresses queued messages from one email to another. */
  readdress(oldEmail: string, newEmail: string): void {
    this.sql.exec("UPDATE outbox SET payload = json_set(payload, '$.email', ?) WHERE json_extract(payload, '$.email') = ?", newEmail, oldEmail);
  }

  /** Whether there are still user updates for this email (waiting for a retry, or being delivered). */
  hasUserUpdates(email: string): boolean {
    return this.sql.exec(
      "SELECT 1 FROM outbox WHERE json_extract(payload, '$.kind') LIKE 'user.%' AND json_extract(payload, '$.email') = ? LIMIT 1", email,
    ).toArray().length > 0;
  }

  /** When the earliest waiting message is due, or null when nothing is queued. */
  nextAttemptAt(): number | null {
    return this.ready() ? this.sql.exec<{ at: number | null }>('SELECT MIN(next_attempt_at) AS at FROM outbox').one().at : null;
  }

  pending(): number {
    return this.ready() ? this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox').one().n : 0;
  }

  /**
   * Delivers the due messages that match `filter`. With `skipRetryWait`, matching messages go now even if they are
   * waiting for a retry (still together and in order).
   */
  process(filter: (message: M) => boolean, skipRetryWait: boolean): Promise<void> {
    const run = this.run.then(() => this.processNow(filter, skipRetryWait));
    this.run = run.catch(() => undefined);
    return run;
  }

  private async processNow(filter: (message: M) => boolean, skipRetryWait: boolean) {
    if (!this.ready()) {
      return;
    }
    const now = Date.now();
    const rows = this.sql.exec<OutboxRow>('SELECT id, payload, attempts, next_attempt_at FROM outbox ORDER BY id').toArray();

    const batches = new Map<string, { rows: OutboxRow[]; messages: M[] }>();
    const blocked = new Set<string>();
    for (const row of rows) {
      const message = JSON.parse(row.payload) as M;
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
      const batch = batches.get(key) ?? { rows: [], messages: [] };
      batch.rows.push(row);
      batch.messages.push(message);
      batches.set(key, batch);
    }

    await Promise.all([...batches.values()].map(async batch => {
      const ids = batch.rows.map(row => row.id);
      const placeholders = ids.map(() => '?').join(',');
      try {
        await this.deliver(batch.messages);
        this.sql.exec(`DELETE FROM outbox WHERE id IN (${placeholders})`, ...ids);
      } catch (error) {
        const attempts = batch.rows[0].attempts + 1;
        const kind = batch.messages[0].kind;
        const heldBack = error instanceof RetryLater;
        if (isPermanentMailError(error) || attempts >= MAX_ATTEMPTS) {
          if (heldBack) {
            console.warn('Dropping a message held back too long', { kind, count: ids.length, attempts, reason: error.message });
          } else {
            console.error('Dropping outbox messages', { kind, count: ids.length, attempts, error: String(error) });
          }
          this.sql.exec(`DELETE FROM outbox WHERE id IN (${placeholders})`, ...ids);
          return;
        }
        if (heldBack) {
          console.info('Outbox delivery held back, will retry', { kind, count: ids.length, attempts, reason: error.message });
        } else {
          console.warn('Outbox delivery failed, will retry', { kind, count: ids.length, attempts, error: String(error) });
        }
        const retryAt = Date.now() + Math.min(1000 * 2 ** attempts, MAX_BACKOFF_MS);
        this.sql.exec(`UPDATE outbox SET attempts = ?, next_attempt_at = ? WHERE id IN (${placeholders})`, attempts, retryAt, ...ids);
      }
    }));
  }
}
