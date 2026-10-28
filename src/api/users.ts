import { fail } from 'src/api/errors';
import { takeAllMail, tooMany } from 'src/api/rateLimit';
import { UserToken } from 'src/api/types';
import { UserRecord } from 'src/do/types';
import { Env } from 'src/env';
import { MailMessage, sendMail } from 'src/mail';
import { JwtHelpers } from 'src/utils/jwt';
import { nodeIdToStr } from 'src/utils/strings/nodeId';
import { PublicJwk, thumbprint } from 'src/utils/dpop';
import { annotate } from 'src/utils/tracing';

/** Session tokens last 30 days. */
const SESSION_TTL = 60 * 60 * 24 * 30;

/**
 * A session token for the user, with their current token version, and the user: the answer to a sign-in. With `key`,
 * the token is bound to it: every request with it then needs a proof signed by that key (src/utils/dpop.ts).
 */
export async function issueSession(env: Env, jwt: JwtHelpers, user: UserRecord, key?: PublicJwk) {
  annotate({ 'session.bound': Boolean(key) });
  const userToken = await jwt.issueToken<UserToken>('UserToken', {
    sub: nodeIdToStr({ kind: 'User', id: user.id }),
    email: user.email,
    ver: user.tokenVersion,
    ...(key ? { cnf: { jkt: await thumbprint(key) } } : {}),
  }, { ttl: SESSION_TTL });
  return { userToken, user, expiresAt: new Date(Date.now() + SESSION_TTL * 1000).toISOString() };
}

/**
 * Sends one of the emails a person asked for (sign-in, account links). Throws a 429 when the limit on all emails
 * together is used up, and a 503 when it couldn't be sent, so the person knows to try again; callers free the
 * request's idempotency key first.
 */
export async function sendRequestedMail(env: Env, to: string, message: MailMessage, field: string | undefined, what = 'the email') {
  if (!await takeAllMail(env)) {
    annotate({ 'mail.sent': false });
    throw tooMany({ message: `We're sending a lot of emails right now, so we couldn't send ${what}. Please try again in a few minutes.`, field });
  }
  try {
    await sendMail(env, to, message);
    annotate({ 'mail.sent': true });
  } catch (error) {
    annotate({ 'mail.sent': false });
    console.error(`Unable to send ${what}`, String(error));
    throw fail('unavailable', `We couldn't send ${what} right now. Please try again in a few minutes.`, field);
  }
}

/** Sends a courtesy email whose failure doesn't fail the request (the change can't happen without the link anyway). */
export async function sendCourtesyMail(env: Env, to: string, message: MailMessage) {
  try {
    await sendMail(env, to, message);
  } catch (error) {
    console.error('Unable to send a courtesy email', String(error));
  }
}
