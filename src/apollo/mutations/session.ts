import { userToNode } from 'src/apollo/resolvers/user';
import { UserToken } from 'src/apollo/types';
import { UserRecord } from 'src/do/types';
import { JwtHelpers } from 'src/utils/jwt';

/** Session tokens last 30 days. */
const SESSION_TTL = 60 * 60 * 24 * 30;

/** Issues a session token for the user (with their current token version): the payload of a successful sign-in. */
export async function issueSession(issueToken: JwtHelpers['issueToken'], user: UserRecord) {
  const node = userToNode(user);
  const userToken = await issueToken<UserToken>('UserToken', { sub: node.id, email: user.email, ver: user.tokenVersion }, { ttl: SESSION_TTL });
  return { status: 'ok' as const, userToken, user: node };
}
