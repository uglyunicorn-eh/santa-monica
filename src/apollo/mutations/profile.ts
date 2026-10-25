import { ApolloContext, requireUser } from 'src/apollo/context';
import { userToNode } from 'src/apollo/resolvers/user';
import { AccountDeletionToken, EmailChangeToken } from 'src/apollo/types';
import { renderAccountDeletion, renderEmailChange, renderEmailChangeNotice } from 'src/mail';
import _ from 'src/utils/graphql/resolvable';
import { nodeIdToStr, strToNodeId } from 'src/utils/strings/nodeId';
import { annotate } from 'src/utils/tracing';

import { emailRateLimit } from './rateLimit';
import { issueSession } from './session';
import { ConfirmTokenInput, RequestEmailChangeInput, UpdateNameInput } from './types';
import { confirmTokenInputSchema, noInputSchema, requestEmailChangeInputSchema, updateNameInputSchema } from './validation';

import { baseUrl } from 'src/config.json';

/** Account links (deletion, email change) work for an hour. */
const LINK_TTL = 60 * 60;

const error = (fieldName: string | null, message: string) => ({
  status: 'error' as const,
  userErrors: [{ fieldName, messages: [message] }],
});

const sessionExpired = error(null, 'Your session has expired. Please sign in again.');
const tooManyRequests = error(null, "Whoa, that's a lot of emails! Please wait a minute and try again.");
const notSent = (fieldName: string | null) => error(fieldName, "We couldn't send the email right now. Please try again in a few minutes.");
const invalidLink = error('token', 'This link is invalid or has expired. Please request a new one.');
const usedLink = error('token', 'This link has already been used. Please request a new one.');
const accountGone = error('token', 'This account no longer exists.');
const accountBusy = error('token', 'Another change to this account is in progress. Please try again in a minute.');
const notFinished = error('token', "We couldn't finish this right now. Please open the link again in a few minutes.");
const emailTaken = (fieldName: string) => error(fieldName, 'This email is already used by another account.');

const startFailed = { used: usedLink, gone: accountGone, busy: accountBusy };

/** Runs a mutation only with a session, checked before its input is validated. */
const withSession = <A, R>(mutation: (args: A, context: ApolloContext) => R) => (args: A, context: ApolloContext) => {
  requireUser(context);
  return mutation(args, context);
};

/** Verifies an emailed account link and returns the user id it is for, or null if it is not valid. */
async function verifyLink<T extends AccountDeletionToken | EmailChangeToken>(
  { jwtVerify }: ApolloContext, token: string, type: 'AccountDeletion' | 'EmailChange',
): Promise<(T & { userId: string; exp: number }) | null> {
  try {
    const payload = await jwtVerify<T>(token, type);
    const { kind, id } = strToNodeId(payload.sub);
    if (kind !== 'User' || !payload.jti || !payload.exp || !payload.email) {
      return null;
    }
    return { ...payload, userId: id, exp: payload.exp };
  } catch {
    return null;
  }
}

/** Sends an account email. Returns an error payload, or null when it went out. Callers rate-limit first. */
async function sendAccountMail(context: ApolloContext, to: string, message: Parameters<ApolloContext['sendMail']>[1], fieldName: string | null) {
  try {
    await context.sendMail(to, message);
    annotate({ 'mail.sent': true });
    return null;
  } catch (e) {
    annotate({ 'mail.sent': false });
    console.error('Unable to send an account email', String(e));
    return notSent(fieldName);
  }
}

/**
 * Settles every call. Returns the values of those that went through, which of them did (by position), and how many
 * failed; the failures are logged.
 */
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

export default {
  // The confirm mutations work from an emailed link alone (maybe in another browser), so each mutation that needs a
  // session asks for it itself (withSession).
  profile: () => profileMutations,
};

const profileMutations = {

  /**
   * Sets the profile name: the default name for parties the user joins from now on. Parties already joined keep the
   * name the user joined them with. One UserDO call, which also checks the session is still valid.
   */
  updateName: withSession(_(updateNameInputSchema, 'updateName')(async ({ name }: UpdateNameInput, { env, userId, userEmail, tokenVersion }: ApolloContext) => {
    const user = await env.USER.getByName(userEmail!).updateName(name, { userId: userId!, tokenVersion });
    return user ? { status: 'ok' as const, user: userToNode(user) } : sessionExpired;
  })),

  /** Emails a link that deletes the account (see `confirmAccountDeletion`). */
  requestAccountDeletion: withSession(_(noInputSchema, 'requestAccountDeletion')(async (input: unknown, context: ApolloContext) => {
    const { env, clientIp, userEmail, retrieveUser, issueToken } = context;
    const [rateLimited, user] = await Promise.all([emailRateLimit(env, clientIp, userEmail!), retrieveUser()]);
    annotate({ 'auth.rate_limited': rateLimited ?? false });
    if (rateLimited) {
      return tooManyRequests;
    }
    if (!user) {
      return sessionExpired;
    }
    const token = await issueToken<AccountDeletionToken>('AccountDeletion', {
      sub: nodeIdToStr({ kind: 'User', id: user.id }), email: user.email, jti: crypto.randomUUID(),
    }, { ttl: LINK_TTL });
    const message = renderAccountDeletion({ url: `${baseUrl}/profile/delete/${token}`, assetsUrl: env.PUBLIC_URL });
    return await sendAccountMail(context, user.email, message, null) ?? {};
  })),

  /**
   * Deletes the account from the emailed link. Open parties the user hosts are deleted, open parties they joined are
   * left, and in drawn parties their membership is anonymized (see `PartyDO.forgetMember`). Then the UserDO is
   * tombstoned, which also revokes every session token. One call to each of the user's parties. If a party can't be
   * reached, the account stays and the link can be opened again: what was done already is not repeated.
   */
  confirmAccountDeletion: _(confirmTokenInputSchema, 'confirmAccountDeletion')(async ({ token }: ConfirmTokenInput, context: ApolloContext) => {
    const link = await verifyLink<AccountDeletionToken>(context, token, 'AccountDeletion');
    if (!link) {
      annotate({ 'account.link': 'invalid' });
      return invalidLink;
    }
    annotate({ 'user.id': link.userId });
    const user = context.env.USER.getByName(link.email);
    const started = await user.startAccountChange(link.userId, link.jti, link.exp * 1000);
    if (!started.ok) {
      annotate({ 'account.link': started.reason });
      return startFailed[started.reason];
    }
    const { values: done, failed } = await settleAll(
      started.parties.map(slug => context.env.PARTY.getByName(slug).forgetMember(link.userId, link.email)),
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
      return notFinished;
    }
    annotate({ 'account.link': 'redeemed' });
    await user.tombstone();
    return {};
  }),

  /** Emails a link to the new address that moves the account there, and a notice to the current one. */
  requestEmailChange: withSession(_(requestEmailChangeInputSchema, 'requestEmailChange')(async (input: RequestEmailChangeInput, context: ApolloContext) => {
    const { env, clientIp, retrieveUser, issueToken } = context;
    const newEmail = input.email.toLowerCase();
    const [rateLimited, user, taken] = await Promise.all([
      emailRateLimit(env, clientIp, newEmail), retrieveUser(), env.USER.getByName(newEmail).get(),
    ]);
    annotate({ 'auth.rate_limited': rateLimited ?? false });
    if (rateLimited) {
      return tooManyRequests;
    }
    if (!user) {
      return sessionExpired;
    }
    if (newEmail === user.email) {
      return error('email', "That's already your email.");
    }
    if (taken) {
      return emailTaken('email');
    }
    const token = await issueToken<EmailChangeToken>('EmailChange', {
      sub: nodeIdToStr({ kind: 'User', id: user.id }), email: user.email, newEmail, jti: crypto.randomUUID(),
    }, { ttl: LINK_TTL });
    const link = renderEmailChange({ url: `${baseUrl}/profile/email/${token}`, oldEmail: user.email, newEmail, assetsUrl: env.PUBLIC_URL });
    const failed = await sendAccountMail(context, newEmail, link, 'email');
    if (failed) {
      return failed;
    }
    // The notice is a courtesy: the change can't happen without the link, so a failed notice doesn't fail the request.
    await sendAccountMail(context, user.email, renderEmailChangeNotice({ oldEmail: user.email, newEmail, assetsUrl: env.PUBLIC_URL }), null);
    return {};
  })),

  /**
   * Moves the account to the new email from the emailed link: the parties not drawn yet move the membership and their
   * queued updates to the new email first, then the account is copied there (same id, a newer token version) and the
   * old one is tombstoned. Drawn parties keep the old email. Returns a session token for the new email; every token
   * issued before stops working.
   */
  confirmEmailChange: _(confirmTokenInputSchema, 'confirmEmailChange')(async ({ token }: ConfirmTokenInput, context: ApolloContext) => {
    const { env, issueToken } = context;
    const link = await verifyLink<EmailChangeToken>(context, token, 'EmailChange');
    if (!link || !link.newEmail) {
      annotate({ 'account.link': 'invalid' });
      return invalidLink;
    }
    annotate({ 'user.id': link.userId });
    const { userId, email: oldEmail, newEmail } = link;
    const oldUser = env.USER.getByName(oldEmail);
    const newUser = env.USER.getByName(newEmail);
    const [taken, started] = await Promise.all([newUser.get(), oldUser.startAccountChange(userId, link.jti, link.exp * 1000)]);
    if (!started.ok) {
      annotate({ 'account.link': started.reason });
      return startFailed[started.reason];
    }
    if (taken) {
      annotate({ 'account.link': 'email_taken' });
      await oldUser.abortAccountChange(link.jti);
      return emailTaken('token');
    }

    const move = (slug: string, from: string, to: string) => env.PARTY.getByName(slug).changeMemberEmail(userId, from, to);
    // On the way back nothing is left to do if that fails too: a later change moves every party again.
    const moveBack = (slugs: string[]) => settleAll(slugs.map(slug => move(slug, newEmail, oldEmail)), 'move a party back to the old email');

    const { values, ok, failed } = await settleAll(started.parties.map(slug => move(slug, oldEmail, newEmail)), 'move a party to a new email');
    if (failed) {
      await moveBack(started.parties.filter((slug, i) => ok[i]));
      await oldUser.abortAccountChange(link.jti);
      annotate({ 'account.link': 'not_finished' });
      return notFinished;
    }
    const summaries = values.filter(summary => summary !== null);
    const moved = await newUser.receive({ ...started.user, email: newEmail, tokenVersion: started.user.tokenVersion + 1 }, summaries);
    if (!moved) {
      // Someone signed up with the new email in the meantime: put the parties back on the old one.
      await moveBack(started.parties);
      await oldUser.abortAccountChange(link.jti);
      annotate({ 'account.link': 'email_taken' });
      return emailTaken('token');
    }
    await oldUser.tombstone();
    annotate({ 'account.link': 'redeemed', 'account.parties': started.parties.length });
    return await issueSession(issueToken, moved);
  }),
};
