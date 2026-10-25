import { BaseContext } from '@apollo/server';
import { GraphQLError } from 'graphql';
import { Context } from 'hono';

import { Party, UserToken } from 'src/apollo/types';
import { UserRecord } from 'src/do/types';
import { Env } from 'src/env';
import { MailMessage, sendMail } from 'src/mail';
import { JwtHelpers, createJwtHelpers } from 'src/utils/jwt';
import { sessionMatches } from 'src/utils/session';
import { strToNodeId } from 'src/utils/strings/nodeId';

import { domain } from 'src/config.json';

export interface ApolloContext extends BaseContext, JwtHelpers {
  env: Env;
  clientIp: string;
  /** Set when the request carries a valid session token. */
  userId?: string;
  userEmail?: string;
  /** The version the session token was issued with; undefined for tokens issued before versions existed. */
  tokenVersion?: number;
  /**
   * Reads the signed-in user's profile (one UserDO call). Null without a session, or when the session no longer
   * belongs to the user (deleted account, revoked token). The token itself is not checked against the UserDO on every
   * request, only where the profile is read anyway and in the mutations that need it (see README).
   */
  retrieveUser: () => Promise<UserRecord | null>;
  sendMail: (to: string, message: MailMessage) => Promise<void>;
  /** Party codes looked up with `party(code)` in this request, for the per-request cap (see MAX_PARTY_LOOKUPS). */
  partyLookups?: Set<string>;
  /** Party views loaded during this request, so each party is asked at most once. */
  partyNodes?: Map<string, Promise<Party | null>>;
};

/** Verifies the session token, once per request. An invalid or missing token means an anonymous request. */
export async function authenticate(token: string | undefined, jwtVerify: JwtHelpers['jwtVerify']) {
  if (!token) {
    return {};
  }
  try {
    const { sub, email, ver } = await jwtVerify<UserToken>(token, 'UserToken');
    const { kind, id } = strToNodeId(sub);
    if (kind !== 'User' || !email) {
      return {};
    }
    return typeof ver === 'number' ? { userId: id, userEmail: email, tokenVersion: ver } : { userId: id, userEmail: email };
  } catch {
    return {};
  }
}

export const makeContext = async (c: Context<{ Bindings: Env }>): Promise<ApolloContext> => {
  const env = c.env;
  const jwt = createJwtHelpers({ privateKey: env.JWT_PRIVATE_KEY, issuer: domain });
  const { userId, userEmail, tokenVersion } = await authenticate(c.req.header('authorization')?.split(' ')[1], jwt.jwtVerify);
  return {
    env,
    clientIp: c.req.header('cf-connecting-ip') ?? 'unknown',
    userId,
    userEmail,
    tokenVersion,
    retrieveUser: async () => {
      if (!userId || !userEmail) {
        return null;
      }
      const user = await env.USER.getByName(userEmail).get();
      return sessionMatches(user, { userId, tokenVersion }) ? user : null;
    },
    sendMail: (to, message) => sendMail(env, to, message),
    ...jwt,
  };
};

/** Mutations other than sign-in need a session. */
export function requireUser(context: ApolloContext): asserts context is ApolloContext & { userId: string; userEmail: string } {
  if (!context.userId || !context.userEmail) {
    throw new GraphQLError('UNAUTHENTICATED');
  }
}
