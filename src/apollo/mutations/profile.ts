import { ApolloContext, requireUser } from 'src/apollo/context';
import { userToNode } from 'src/apollo/resolvers/user';
import { AccountDeletionToken, EmailChangeToken, UserToken } from 'src/apollo/types';
import { renderAccountDeletion, renderEmailChange, renderEmailChangeNotice } from 'src/mail';
import _ from 'src/utils/graphql/resolvable';
import { nodeIdToStr, strToNodeId } from 'src/utils/strings/nodeId';
import { annotate } from 'src/utils/tracing';

import { emailRateLimit } from './rateLimit';
import { ConfirmTokenInput, RequestEmailChangeInput, UpdateNameInput } from './types';
import { confirmTokenInputSchema, noInputSchema, requestEmailChangeInputSchema, updateNameInputSchema } from './validation';

import { baseUrl } from 'src/config.json';

/** Account links (deletion, email change) work for an hour. */
const LINK_TTL = 60 * 60;
const SESSION_TTL = 60 * 60 * 24 * 30;

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
const emailTaken = (fieldName: string) => error(fieldName, 'This email is already used by another account.');

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

/** Mails a link, rate-limited like magic links. Returns an error payload, or null when the mail went out. */
async function mailLink(context: ApolloContext, to: string, message: Parameters<ApolloContext['sendMail']>[1], fieldName: string | null) {
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

export default {
  // The confirm mutations work from an emailed link alone (maybe in another browser), so each mutation that needs a
  // session asks for it itself.
  profile: () => profileMutations,
};

const profileMutations = {

  /**
   * Sets the profile name: the default name for parties the user joins from now on. Parties already joined keep the
   * name the user joined them with. One UserDO call, which also checks the session is still valid.
   */
  updateName: _(updateNameInputSchema, 'updateName')(async ({ name }: UpdateNameInput, context: ApolloContext) => {
    requireUser(context);
    const { env, userId, userEmail, tokenVersion } = context;
    const user = await env.USER.getByName(userEmail).updateName(name, { userId, tokenVersion });
    return user ? { status: 'ok' as const, user: userToNode(user) } : sessionExpired;
  }),

  /** Emails a link that deletes the account (see `confirmAccountDeletion`). */
  requestAccountDeletion: _(noInputSchema, 'requestAccountDeletion')(async (input: unknown, context: ApolloContext) => {
    requireUser(context);
    const { env, clientIp, userEmail, retrieveUser, issueToken } = context;
    const rateLimited = await emailRateLimit(env, clientIp, userEmail);
    annotate({ 'auth.rate_limited': rateLimited ?? false });
    if (rateLimited) {
      return tooManyRequests;
    }
    const user = await retrieveUser();
    if (!user) {
      return sessionExpired;
    }
    const token = await issueToken<AccountDeletionToken>('AccountDeletion', {
      sub: nodeIdToStr({ kind: 'User', id: user.id }), email: user.email, jti: crypto.randomUUID(),
    }, { ttl: LINK_TTL });
    const message = renderAccountDeletion({ url: `${baseUrl}/profile/delete/${token}`, assetsUrl: env.PUBLIC_URL });
    return await mailLink(context, user.email, message, null) ?? {};
  }),

  /**
   * Deletes the account from the emailed link. Open parties the user hosts are deleted, open parties they joined are
   * left, and in drawn parties their membership is anonymized (see `PartyDO.forgetMember`). Then the UserDO is
   * tombstoned, which also revokes every session token. One call to each of the user's parties.
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
      return started.reason === 'used' ? usedLink : accountGone;
    }
    const results = await Promise.all(started.parties.map(slug => context.env.PARTY.getByName(slug).forgetMember(link.userId, link.email)));
    annotate({
      'account.link': 'redeemed',
      'account.parties': results.length,
      'account.parties_deleted': results.filter(r => r === 'deleted').length,
      'account.parties_anonymized': results.filter(r => r === 'anonymized').length,
    });
    await user.tombstone();
    return {};
  }),

  /** Emails a link to the new address that moves the account there, and a notice to the current one. */
  requestEmailChange: _(requestEmailChangeInputSchema, 'requestEmailChange')(async (input: RequestEmailChangeInput, context: ApolloContext) => {
    requireUser(context);
    const { env, clientIp, retrieveUser, issueToken } = context;
    const newEmail = input.email.toLowerCase();
    const rateLimited = await emailRateLimit(env, clientIp, newEmail);
    annotate({ 'auth.rate_limited': rateLimited ?? false });
    if (rateLimited) {
      return tooManyRequests;
    }
    const [user, taken] = await Promise.all([retrieveUser(), env.USER.getByName(newEmail).get()]);
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
    const failed = await mailLink(context, newEmail, link, 'email');
    if (failed) {
      return failed;
    }
    // The notice is a courtesy: the change can't happen without the link, so a failed notice doesn't fail the request.
    await mailLink(context, user.email, renderEmailChangeNotice({ oldEmail: user.email, newEmail, assetsUrl: env.PUBLIC_URL }), null);
    return {};
  }),

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
    if (await env.USER.getByName(newEmail).get()) {
      annotate({ 'account.link': 'email_taken' });
      return emailTaken('token');
    }
    const oldUser = env.USER.getByName(oldEmail);
    const started = await oldUser.startAccountChange(userId, link.jti, link.exp * 1000);
    if (!started.ok) {
      annotate({ 'account.link': started.reason });
      return started.reason === 'used' ? usedLink : accountGone;
    }

    const summaries = await Promise.all(started.parties.map(slug => env.PARTY.getByName(slug).changeMemberEmail(userId, oldEmail, newEmail)));
    const moved = await env.USER.getByName(newEmail).receive(
      { ...started.user, email: newEmail, tokenVersion: started.user.tokenVersion + 1 },
      summaries.filter(summary => summary !== null),
    );
    if (!moved) {
      // Someone signed up with the new email in the meantime: put the parties back on the old one.
      await Promise.all(started.parties.map(slug => env.PARTY.getByName(slug).changeMemberEmail(userId, newEmail, oldEmail)));
      annotate({ 'account.link': 'email_taken' });
      return emailTaken('token');
    }
    await oldUser.tombstone();
    annotate({ 'account.link': 'redeemed', 'account.parties': started.parties.length });

    const node = userToNode(moved);
    const userToken = await issueToken<UserToken>('UserToken', { sub: node.id, email: newEmail, ver: moved.tokenVersion }, { ttl: SESSION_TTL });
    return { status: 'ok' as const, userToken, user: node };
  }),
};
