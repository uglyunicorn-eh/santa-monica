import { fail } from 'src/api/errors';
import { UserRecord } from 'src/do/types';
import { Env } from 'src/env';

export const linkFailed = {
  used: () => fail('link_used', 'This link has already been used. Please request a new one.', 'token'),
  gone: () => fail('invalid_link', 'This account no longer exists.', 'token'),
  busy: () => fail('account_busy', 'Another change to this account is in progress. Please try again in a minute.', 'token'),
};
export const notFinished = () => fail('not_finished', "We couldn't finish this right now. Please open the link again in a few minutes.", 'token');
export const emailTaken = (field: string) => fail('conflict', 'This email is already used by another account.', field);

/** Collects every result, logging the failures. */
export async function settleAll<T>(calls: Promise<T>[], what: string) {
  const settled = await Promise.allSettled(calls);
  const values: T[] = [];
  const ok = settled.map(result => {
    if (result.status === 'rejected') {
      console.error(`Unable to ${what}`, String(result.reason));
      return false;
    }
    values.push(result.value);
    return true;
  });
  return { values, ok, failed: ok.filter(done => !done).length };
}

export type AccountMove = {
  userId: string;
  from: string;
  to: string;
  /** The emailed link that asked for the move: it is used up in the old email's UserDO. */
  jti: string;
  expiresAt: number;
  key?: string;
};

export type AccountMoveResult =
  | { ok: true; user: UserRecord; parties: number }
  | { ok: false; reason: 'gone' | 'used' | 'busy' | 'taken' | 'not_finished' }
  | { ok: false; reason: 'repeat'; current: UserRecord | null };

/**
 * Moves an account to another email: the parties not drawn yet move the membership and their queued updates to the
 * new email first, then the account is copied there (same id, a newer token version) and the old one is tombstoned.
 * Drawn parties keep the old email. Every session token issued before stops working. If a party can't be reached,
 * the parties already moved go back and nothing changes (`not_finished`), so the link can be tried again.
 */
export async function moveAccount(env: Env, { userId, from, to, jti, expiresAt, key }: AccountMove): Promise<AccountMoveResult> {
  const oldUser = env.USER.getByName(from);
  const newUser = env.USER.getByName(to);
  const [current, started] = await Promise.all([
    newUser.get(),
    oldUser.startAccountChange(userId, jti, expiresAt, { key, outcome: to }),
  ]);
  if (!started.ok) {
    return started.reason === 'repeat' ? { ok: false, reason: 'repeat', current } : { ok: false, reason: started.reason };
  }
  if (current) {
    await oldUser.abortAccountChange(jti);
    return { ok: false, reason: 'taken' };
  }

  const move = (slug: string, a: string, b: string) => env.PARTY.getByName(slug).changeMemberEmail(userId, a, b);
  // On the way back nothing is left to do if that fails too: a later change moves every party again.
  const moveBack = (slugs: string[]) => settleAll(slugs.map(slug => move(slug, to, from)), 'move a party back to the old email');

  const { values, ok, failed } = await settleAll(started.parties.map(slug => move(slug, from, to)), 'move a party to a new email');
  if (failed) {
    await moveBack(started.parties.filter((_slug, i) => ok[i]));
    await oldUser.abortAccountChange(jti);
    return { ok: false, reason: 'not_finished' };
  }
  const summaries = values.filter(summary => summary !== null);
  const moved = await newUser.receive({ ...started.user, email: to, tokenVersion: started.user.tokenVersion + 1 }, summaries);
  if (!moved) {
    // Someone signed up with the new email in the meantime: put the parties back on the old one.
    await moveBack(started.parties);
    await oldUser.abortAccountChange(jti);
    return { ok: false, reason: 'taken' };
  }
  await oldUser.tombstone();
  return { ok: true, user: moved, parties: started.parties.length };
}

/**
 * Accounts made before addresses were normalized are kept under the address as it was typed (lowercased). When
 * someone signs in with such an address and the normalized one has no account yet, their account moves there, the
 * way an email change does. Returns what happened, for the logs. Throws when the move has to be tried again, so the
 * sign-in doesn't start an empty account instead.
 */
export async function adoptTypedAccount(env: Env, typed: string, email: string, jti: string, expiresAt: number, key?: string) {
  const [current, old] = await Promise.all([env.USER.getByName(email).get(), env.USER.getByName(typed).get()]);
  if (current || !old) {
    return 'none';
  }
  const moved = await moveAccount(env, { userId: old.id, from: typed, to: email, jti, expiresAt, key });
  if (moved.ok) {
    return 'moved';
  }
  switch (moved.reason) {
    case 'used':
      // Another request with this same link is moving it right now, and signs in with it.
      throw linkFailed.used();
    case 'busy':
    case 'repeat':
      throw linkFailed.busy();
    case 'not_finished':
      throw notFinished();
    default:
      // The old account went away, or the normalized address got one, in the meantime: sign in there as usual.
      return moved.reason;
  }
}
