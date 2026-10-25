import { Hono } from 'hono';
import * as v from 'valibot';

import { action } from 'src/api/action';
import { ApiContext, ApiEnv, RequestSession, clientIp, jwtFor } from 'src/api/context';
import { fail, notSignedIn } from 'src/api/errors';
import { idempotencyKey, keyHash, readBody, readQuery, send } from 'src/api/input';
import { listParties } from 'src/api/party';
import { emailRateLimit } from 'src/api/rateLimit';
import { requireSession } from 'src/api/session';
import { accepted, bodies, partyPage, queries, session as sessionJson, tokens, user as userJson } from 'src/api/schemas';
import { AccountDeletionToken, EmailChangeToken } from 'src/api/types';
import { issueSession, sendCourtesyMail, sendRequestedMail } from 'src/api/users';
import { UserRecord } from 'src/do/types';
import { renderAccountDeletion, renderEmailChange, renderEmailChangeNotice } from 'src/mail';
import { nodeIdToStr } from 'src/utils/strings/nodeId';
import { annotate } from 'src/utils/tracing';

/** Account links (deletion, email change) work for an hour. */
const LINK_TTL = 60 * 60;

const tooManyEmails = () => fail('rate_limited', "Whoa, that's a lot of emails! Please wait a minute and try again.");
const invalidLink = () => fail('invalid_link', 'This link is invalid or has expired. Please request a new one.', 'token');
const startFailed = {
  used: () => fail('link_used', 'This link has already been used. Please request a new one.', 'token'),
  gone: () => fail('invalid_link', 'This account no longer exists.', 'token'),
  busy: () => fail('account_busy', 'Another change to this account is in progress. Please try again in a minute.', 'token'),
};
const notFinished = () => fail('not_finished', "We couldn't finish this right now. Please open the link again in a few minutes.", 'token');
const emailTaken = (field: string) => fail('conflict', 'This email is already used by another account.', field);

export const me = new Hono<ApiEnv>();

me.get('/', requireSession, action('user', async c => {
  const user = await session(c).verify();
  annotate({ 'user.found': Boolean(user) });
  if (!user) {
    throw notSignedIn();
  }
  return send(c, userJson, user);
}));

/**
 * Sets the profile name: the default name for parties the user joins from now on. Parties already joined keep the
 * name the user joined them with. One UserDO call, which also checks the session.
 */
me.patch('/', requireSession, action('updateName', async c => {
  const { name } = await readBody(c, bodies.profile);
  const s = session(c);
  const user = await c.env.USER.getByName(s.email).updateName(name, s);
  if (!user) {
    throw notSignedIn();
  }
  return send(c, userJson, user);
}));

/** The signed-in user's parties, newest first, a page at a time: one UserDO call, which also checks the session. */
me.get('/parties', requireSession, action('partyHistory', async (c, span) => {
  const { first, after } = readQuery(c, queries.partyHistory);
  const s = session(c);
  const page = await listParties(c.env, s.email, s, first, after);
  if (!page) {
    throw notSignedIn();
  }
  span.setAttributes({ 'parties.first': first, 'parties.count': page.count, 'parties.refreshed': page.refreshed, 'parties.has_more': page.hasMore });
  return send(c, partyPage, { items: page.items, hasMore: page.hasMore, endCursor: page.endCursor });
}));

/**
 * Starts an account email request in one UserDO call (session check + idempotency claim), runs `send`, and frees the
 * claim when `send` fails, so a retry sends the email. A repeat of a claimed request answers 202 without sending.
 */
async function mailRequest(c: ApiContext, kind: string, detail: string, deliver: (user: UserRecord) => Promise<void>) {
  const s = session(c);
  const key = idempotencyKey(c);
  const claim = key && `${kind}:${key}`;
  const userDO = c.env.USER.getByName(s.email);
  const user = await userDO.beginMailRequest(s, claim, detail);
  annotate({ 'mail.request_repeated': user === 'repeat' });
  if (!user) {
    throw notSignedIn();
  }
  if (user === 'repeat') {
    return send(c, accepted, { ok: true }, 202);
  }
  try {
    await deliver(user);
  } catch (error) {
    if (claim) {
      await userDO.releaseMailRequest(claim, detail);
    }
    throw error;
  }
  return send(c, accepted, { ok: true }, 202);
}

/** Emails a link that deletes the account (see `/deletion/confirm`). */
me.post('/deletion', requireSession, action('requestAccountDeletion', async c => {
  await readBody(c, bodies.empty);
  const { env } = c;
  return await mailRequest(c, 'deletion', '', async user => {
    const rateLimited = await emailRateLimit(env, clientIp(c), user.email);
    annotate({ 'auth.rate_limited': rateLimited ?? false });
    if (rateLimited) {
      throw tooManyEmails();
    }
    const token = await jwtFor(env).issueToken<AccountDeletionToken>('AccountDeletion', {
      sub: nodeIdToStr({ kind: 'User', id: user.id }), email: user.email, jti: crypto.randomUUID(),
    }, { ttl: LINK_TTL });
    const message = renderAccountDeletion({ url: `${env.FRONTEND_URL}/profile/delete/${token}`, assetsUrl: env.PUBLIC_URL });
    await sendRequestedMail(env, user.email, message, undefined);
  });
}));

/** Emails a link to the new address that moves the account there, and a notice to the current one. */
me.post('/email-change', requireSession, action('requestEmailChange', async c => {
  const { email: newEmail } = await readBody(c, bodies.emailChange);
  const { env } = c;
  return await mailRequest(c, 'email', newEmail, async user => {
    if (newEmail === user.email) {
      throw fail('invalid', "That's already your email.", 'email');
    }
    const [rateLimited, taken] = await Promise.all([emailRateLimit(env, clientIp(c), newEmail), env.USER.getByName(newEmail).get()]);
    annotate({ 'auth.rate_limited': rateLimited ?? false });
    if (rateLimited) {
      throw tooManyEmails();
    }
    if (taken) {
      throw emailTaken('email');
    }
    const token = await jwtFor(env).issueToken<EmailChangeToken>('EmailChange', {
      sub: nodeIdToStr({ kind: 'User', id: user.id }), email: user.email, newEmail, jti: crypto.randomUUID(),
    }, { ttl: LINK_TTL });
    const link = renderEmailChange({ url: `${env.FRONTEND_URL}/profile/email/${token}`, oldEmail: user.email, newEmail, assetsUrl: env.PUBLIC_URL });
    await sendRequestedMail(env, newEmail, link, 'email');
    await sendCourtesyMail(env, user.email, renderEmailChangeNotice({ oldEmail: user.email, newEmail, assetsUrl: env.PUBLIC_URL }));
  });
}));

/**
 * Verifies an emailed account link: the body's token must carry a valid signature for `type`, and its payload must fit
 * that link's schema. Returns the payload, with `sub` read as the user id. Throws 400 when it isn't valid.
 */
async function verifyLink<S extends typeof tokens.accountDeletion | typeof tokens.emailChange>(c: ApiContext, type: 'AccountDeletion' | 'EmailChange', schema: S) {
  const { token } = await readBody(c, bodies.link);
  let payload: unknown;
  try {
    payload = await jwtFor(c.env).jwtVerify(token, type);
  } catch {
    payload = undefined;
  }
  const link = v.safeParse(schema, payload);
  if (!link.success) {
    annotate({ 'account.link': 'invalid' });
    throw invalidLink();
  }
  annotate({ 'user.id': link.output.sub });
  return { ...link.output, userId: link.output.sub } as v.InferOutput<S> & { userId: string };
}

/** Collects every result, logging the failures. */
async function settleAll<T>(calls: Promise<T>[], what: string) {
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

/**
 * Deletes the account from the emailed link. Open parties the user hosts are deleted, open parties they joined are
 * left, and in drawn parties their membership is anonymized (see `PartyDO.forgetMember`). Then the UserDO is
 * tombstoned, which also revokes every session token. One call to each of the user's parties. If a party can't be
 * reached, the account stays and the link can be opened again: what was done already is not repeated. Repeating
 * the request that used the link (same Idempotency-Key) answers ok again.
 */
me.post('/deletion/confirm', action('confirmAccountDeletion', async c => {
  const link = await verifyLink(c, 'AccountDeletion', tokens.accountDeletion);
  const key = await keyHash(idempotencyKey(c));
  const user = c.env.USER.getByName(link.email);
  const started = await user.startAccountChange(link.userId, link.jti, link.exp * 1000, { key });
  annotate({ 'account.link': started.ok ? 'started' : started.reason });
  if (!started.ok) {
    if (started.reason === 'repeat') {
      return send(c, accepted, { ok: true });
    }
    throw startFailed[started.reason]();
  }
  const { values: done, failed } = await settleAll(
    started.parties.map(slug => c.env.PARTY.getByName(slug).forgetMember(link.userId, link.email)),
    'remove a deleted account from a party',
  );
  annotate({
    'account.parties': started.parties.length,
    'account.parties_failed': failed,
    'account.parties_deleted': done.filter(r => r === 'deleted').length,
    'account.parties_anonymized': done.filter(r => r === 'anonymized').length,
  });
  if (failed) {
    annotate({ 'account.link': 'not_finished' });
    await user.abortAccountChange(link.jti);
    throw notFinished();
  }
  annotate({ 'account.link': 'redeemed' });
  await user.tombstone();
  return send(c, accepted, { ok: true });
}));

/**
 * Moves the account to the new email from the emailed link: the parties not drawn yet move the membership and their
 * queued updates to the new email first, then the account is copied there (same id, a newer token version) and the
 * old one is tombstoned. Drawn parties keep the old email. Returns a session token for the new email; every token
 * issued before stops working. Repeating the request that used the link (same Idempotency-Key) signs in again.
 */
me.post('/email-change/confirm', action('confirmEmailChange', async c => {
  const { env } = c;
  const link = await verifyLink(c, 'EmailChange', tokens.emailChange);
  const key = await keyHash(idempotencyKey(c));
  const { userId, email: oldEmail, newEmail } = link;
  const oldUser = env.USER.getByName(oldEmail);
  const newUser = env.USER.getByName(newEmail);
  const jwt = jwtFor(env);
  const [taken, started] = await Promise.all([
    newUser.get(),
    oldUser.startAccountChange(userId, link.jti, link.exp * 1000, { key, outcome: newEmail }),
  ]);
  if (!started.ok) {
    annotate({ 'account.link': started.reason });
    if (started.reason === 'repeat') {
      // The account was moved by this same request: sign in again, as long as it is still there.
      if (taken?.id === userId) {
        return send(c, sessionJson, await issueSession(jwt, taken));
      }
      throw startFailed.used();
    }
    throw startFailed[started.reason]();
  }
  if (taken) {
    annotate({ 'account.link': 'email_taken' });
    await oldUser.abortAccountChange(link.jti);
    throw emailTaken('token');
  }

  const move = (slug: string, from: string, to: string) => env.PARTY.getByName(slug).changeMemberEmail(userId, from, to);
  // On the way back nothing is left to do if that fails too: a later change moves every party again.
  const moveBack = (slugs: string[]) => settleAll(slugs.map(slug => move(slug, newEmail, oldEmail)), 'move a party back to the old email');

  const { values, ok, failed } = await settleAll(started.parties.map(slug => move(slug, oldEmail, newEmail)), 'move a party to a new email');
  if (failed) {
    await moveBack(started.parties.filter((slug, i) => ok[i]));
    await oldUser.abortAccountChange(link.jti);
    annotate({ 'account.link': 'not_finished' });
    throw notFinished();
  }
  const summaries = values.filter(summary => summary !== null);
  const moved = await newUser.receive({ ...started.user, email: newEmail, tokenVersion: started.user.tokenVersion + 1 }, summaries);
  if (!moved) {
    // Someone signed up with the new email in the meantime: put the parties back on the old one.
    await moveBack(started.parties);
    await oldUser.abortAccountChange(link.jti);
    annotate({ 'account.link': 'email_taken' });
    throw emailTaken('token');
  }
  await oldUser.tombstone();
  annotate({ 'account.link': 'redeemed', 'account.parties': started.parties.length });
  return send(c, sessionJson, await issueSession(jwt, moved));
}));

/** The session `requireSession` put on the request. */
function session(c: ApiContext): RequestSession {
  return c.get('session')!;
}
