import { fail } from 'src/api/errors';
import { UserJson, UserToken } from 'src/api/types';
import { UserRecord } from 'src/do/types';
import { Env } from 'src/env';
import { MailMessage, sendMail } from 'src/mail';
import { JwtHelpers } from 'src/utils/jwt';
import { nodeIdToStr } from 'src/utils/strings/nodeId';
import { annotate } from 'src/utils/tracing';

/** Session tokens last 30 days. */
const SESSION_TTL = 60 * 60 * 24 * 30;

/** The signed-in user, email included (the API never returns anyone else's). */
export const toUserJson = (user: UserRecord): UserJson => ({
  id: nodeIdToStr({ kind: 'User', id: user.id }),
  name: user.name,
  email: user.email,
});

/** A session token for the user, with their current token version, and the user: the answer to a sign-in. */
export async function issueSession(jwt: JwtHelpers, user: UserRecord) {
  const json = toUserJson(user);
  const userToken = await jwt.issueToken<UserToken>('UserToken', { sub: json.id, email: user.email, ver: user.tokenVersion }, { ttl: SESSION_TTL });
  return { userToken, user: json };
}

/**
 * Sends one of the emails a person asked for (sign-in, account links). Throws a 503 when it couldn't be sent, so the
 * person knows to try again; callers free the request's idempotency key first.
 */
export async function sendRequestedMail(env: Env, to: string, message: MailMessage, field: string | undefined, what = 'the email') {
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
