import { Hono } from 'hono';
import * as v from 'valibot';

import { emailTaken, linkFailed, moveAccount, notFinished, settleAll } from 'src/api/account';
import { action } from 'src/api/action';
import { ApiContext, ApiEnv, RequestSession, clientIp, jwtFor } from 'src/api/context';
import { fail, notSignedIn } from 'src/api/errors';
import { idempotencyKey, keyHash, readBody, readQuery, send } from 'src/api/input';
import { listParties } from 'src/api/party';
import { ADDRESS_QUOTA, NOTICE_QUOTA, emailRateLimit, tooManyForAddress } from 'src/api/rateLimit';
import { requireSession } from 'src/api/session';
import { accepted, bodies, partyPage, queries, session as sessionJson, tokens, user as userJson } from 'src/api/schemas';
import { AccountDeletionToken, EmailChangeCancelToken, EmailChangeToken } from 'src/api/types';
import { issueSession, sendCourtesyMail, sendRequestedMail } from 'src/api/users';
import type { MailQuota } from 'src/do/UserDO';
import { UserRecord } from 'src/do/types';
import { renderAccountDeletion, renderEmailChange, renderEmailChangeNotice, renderEmailTakenNotice } from 'src/mail';
import { canonicalEmail } from 'src/utils/email';
import { nodeIdToStr } from 'src/utils/strings/nodeId';
import { annotate } from 'src/utils/tracing';

import { from } from 'src/config.json';

/** Account links (deletion, email change) work for an hour. */
const LINK_TTL = 60 * 60;

const tooManyEmails = () => fail('rate_limited', "Whoa, that's a lot of emails! Please wait a minute and try again.");
const invalidLink = () => fail('invalid_link', 'This link is invalid or has expired. Please request a new one.', 'token');
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
 * Starts an account email request in one UserDO call (session check, idempotency claim, and counting the email to
 * the user's address against `quota`), runs `deliver`, and frees the claim when `deliver` fails, so a retry sends the
 * email. A repeat of a claimed request answers 202 without sending.
 */
async function mailRequest(c: ApiContext, kind: string, detail: string, quota: MailQuota, deliver: (user: UserRecord) => Promise<void>) {
  const s = session(c);
  const key = idempotencyKey(c);
  const claim = key && `${kind}:${key}`;
  const userDO = c.env.USER.getByName(s.email);
  const user = await userDO.beginMailRequest(s, claim, detail, quota);
  annotate({ 'mail.request_repeated': user === 'repeat', 'mail.capped': user === 'capped' });
  if (!user) {
    throw notSignedIn();
  }
  if (user === 'repeat') {
    return send(c, accepted, { ok: true }, 202);
  }
  if (user === 'capped') {
    throw tooManyForAddress();
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

/**
 * Signs out every device, this one included: every session token issued so far stops working, and so does every
 * pending account link. One UserDO call, which also checks the session; a repeat finds the session already gone (401).
 */
me.post('/sign-out', requireSession, action('signOutEverywhere', async c => {
  await readBody(c, bodies.empty);
  const s = session(c);
  if (!await c.env.USER.getByName(s.email).signOutEverywhere(s)) {
    throw notSignedIn();
  }
  return send(c, accepted, { ok: true });
}));

/** Emails a link that deletes the account (see `/deletion/confirm`). */
me.post('/deletion', requireSession, action('requestAccountDeletion', async c => {
  await readBody(c, bodies.empty);
  const { env } = c;
  return await mailRequest(c, 'deletion', '', ADDRESS_QUOTA, async user => {
    const rateLimited = await emailRateLimit(env, clientIp(c), user.email);
    annotate({ 'auth.rate_limited': rateLimited ?? false });
    if (rateLimited) {
      throw tooManyEmails();
    }
    const token = await jwtFor(env).issueToken<AccountDeletionToken>('AccountDeletion', {
      sub: nodeIdToStr({ kind: 'User', id: user.id }), email: user.email, jti: crypto.randomUUID(), ver: user.tokenVersion,
    }, { ttl: LINK_TTL });
    const message = renderAccountDeletion({ url: `${env.FRONTEND_URL}/profile/delete/${token}`, assetsUrl: env.PUBLIC_URL });
    await sendRequestedMail(env, user.email, message, undefined);
  });
}));

/**
 * Emails a link to the new address that moves the account there, and a notice to the current one with a link that
 * cancels it ("This wasn't me"). When the new address already has an account, it gets a notice instead of the link,
 * and the answer is the same as for a free address, so this can't be used to find out which addresses have accounts.
 */
me.post('/email-change', requireSession, action('requestEmailChange', async c => {
  const { email: newEmail, typed } = await readBody(c, bodies.emailChange);
  const { env } = c;
  // The notice to the current address counts against it but never blocks the change; the new address's cap does.
  return await mailRequest(c, 'email', newEmail, NOTICE_QUOTA, async user => {
    if (newEmail === canonicalEmail(user.email)) {
      throw fail('invalid', "That's already your email.", 'email');
    }
    // An account made before addresses were normalized may still be kept under the address as typed.
    const [rateLimited, recipient, takenAsTyped] = await Promise.all([
      emailRateLimit(env, clientIp(c), newEmail),
      env.USER.getByName(newEmail).checkRecipient(ADDRESS_QUOTA),
      typed === newEmail ? null : env.USER.getByName(typed).get(),
    ]);
    annotate({ 'auth.rate_limited': rateLimited ?? false });
    if (rateLimited) {
      throw tooManyEmails();
    }
    annotate({ 'mail.capped': recipient === 'capped' });
    if (recipient === 'capped') {
      throw tooManyForAddress('email');
    }
    const taken = recipient === 'taken' || Boolean(takenAsTyped);
    annotate({ 'account.email_taken': taken });
    const jwt = jwtFor(env);
    const sub = nodeIdToStr({ kind: 'User', id: user.id });
    const jti = crypto.randomUUID();
    if (taken) {
      await sendRequestedMail(env, newEmail, renderEmailTakenNotice({ email: newEmail, assetsUrl: env.PUBLIC_URL }), 'email');
    } else {
      const token = await jwt.issueToken<EmailChangeToken>('EmailChange', {
        sub, email: user.email, newEmail, jti, ver: user.tokenVersion,
      }, { ttl: LINK_TTL });
      const link = renderEmailChange({ url: `${env.FRONTEND_URL}/profile/email/${token}`, oldEmail: user.email, newEmail, assetsUrl: env.PUBLIC_URL });
      await sendRequestedMail(env, newEmail, link, 'email');
    }
    // Sent the same way in both cases. Cancelling when nothing was sent still signs out everywhere, which is what
    // someone who didn't ask for the change wants.
    const cancel = await jwt.issueToken<EmailChangeCancelToken>('EmailChangeCancel', { sub, email: user.email, jti }, { ttl: LINK_TTL });
    await sendCourtesyMail(env, user.email, renderEmailChangeNotice({
      oldEmail: user.email, newEmail, cancelUrl: `${env.FRONTEND_URL}/profile/email/cancel/${cancel}`, assetsUrl: env.PUBLIC_URL,
    }));
  });
}));

/**
 * Verifies an emailed account link: the body's token must carry a valid signature for `type`, and its payload must fit
 * that link's schema. Returns the payload, with `sub` read as the user id. Throws 400 when it isn't valid.
 */
async function verifyLink<S extends typeof tokens.accountDeletion | typeof tokens.emailChange | typeof tokens.emailChangeCancel>(
  c: ApiContext, type: 'AccountDeletion' | 'EmailChange' | 'EmailChangeCancel', schema: S,
) {
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
  const started = await user.startAccountChange(link.userId, link.jti, link.exp * 1000, { key, ver: link.ver });
  annotate({ 'account.link': started.ok ? 'started' : started.reason });
  if (!started.ok) {
    if (started.reason === 'repeat') {
      return send(c, accepted, { ok: true });
    }
    throw linkFailed[started.reason]();
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
 * Moves the account to the new email from the emailed link (see `moveAccount`). Returns a session token for the new
 * email; every token issued before stops working. Repeating the request that used the link (same Idempotency-Key)
 * signs in again.
 */
me.post('/email-change/confirm', action('confirmEmailChange', async c => {
  const { env } = c;
  const link = await verifyLink(c, 'EmailChange', tokens.emailChange);
  const key = await keyHash(idempotencyKey(c));
  const jwt = jwtFor(env);
  const moved = await moveAccount(env, {
    userId: link.userId, from: link.email, to: link.newEmail, jti: link.jti, expiresAt: link.exp * 1000, key, ver: link.ver,
  });
  if (moved.ok) {
    annotate({ 'account.link': 'redeemed', 'account.parties': moved.parties });
    return send(c, sessionJson, await issueSession(jwt, moved.user));
  }
  annotate({ 'account.link': moved.reason === 'taken' ? 'email_taken' : moved.reason });
  switch (moved.reason) {
    case 'repeat':
      // The account was moved by this same request: sign in again, as long as it is still there.
      if (moved.current?.id === link.userId) {
        return send(c, sessionJson, await issueSession(jwt, moved.current));
      }
      throw linkFailed.used();
    case 'taken':
      throw emailTaken('token');
    case 'not_finished':
      throw notFinished();
    default:
      throw linkFailed[moved.reason]();
  }
}));

/**
 * "This wasn't me", from the notice about an email change: the change can no longer be confirmed, and every session
 * and every other pending account link stops working, so whoever asked for the change is signed out too. The account
 * keeps its email. One UserDO call. Repeating the request that cancelled (same Idempotency-Key) answers ok again.
 */
me.post('/email-change/cancel', action('cancelEmailChange', async c => {
  const link = await verifyLink(c, 'EmailChangeCancel', tokens.emailChangeCancel);
  const key = await keyHash(idempotencyKey(c));
  const cancelled = await c.env.USER.getByName(link.email).cancelAccountChange(link.userId, link.jti, link.exp * 1000, key);
  annotate({ 'account.link': cancelled });
  switch (cancelled) {
    case 'cancelled':
    case 'repeat':
      return send(c, accepted, { ok: true });
    case 'too_late':
      throw fail('link_used', `The email was already changed. If this wasn't you, write to ${from.email}.`, 'token');
    default:
      throw linkFailed[cancelled]();
  }
}));

/** The session `requireSession` put on the request. */
function session(c: ApiContext): RequestSession {
  return c.get('session')!;
}
