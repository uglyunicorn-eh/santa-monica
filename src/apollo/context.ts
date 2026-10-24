import { BaseContext } from '@apollo/server';
import { GraphQLError } from 'graphql';
import { Context } from 'hono';

import { Party, UserToken } from 'src/apollo/types';
import { UserRecord } from 'src/do/types';
import { Env } from 'src/env';
import { MailMessage, sendMail } from 'src/mail';
import { JwtHelpers, createJwtHelpers } from 'src/utils/jwt';
import { strToNodeId } from 'src/utils/strings/nodeId';

import { domain } from 'src/config.json';

export interface ApolloContext extends BaseContext, JwtHelpers {
  env: Env;
  clientIp: string;
  /** Set when the request carries a valid session token. */
  userId?: string;
  userEmail?: string;
  /** Reads the signed-in user's profile (one UserDO call), or null without a session. */
  retrieveUser: () => Promise<UserRecord | null>;
  sendMail: (to: string, message: MailMessage) => Promise<void>;
  /** Party views loaded during this request, so each party is asked at most once. */
  partyNodes?: Map<string, Promise<Party | null>>;
};

/** Verifies the session token, once per request. An invalid or missing token means an anonymous request. */
export async function authenticate(token: string | undefined, jwtVerify: JwtHelpers['jwtVerify']) {
  if (!token) {
    return {};
  }
  try {
    const { sub, email } = await jwtVerify<UserToken>(token, 'UserToken');
    const { kind, id } = strToNodeId(sub);
    return kind === 'User' && email ? { userId: id, userEmail: email } : {};
  } catch {
    return {};
  }
}

export const makeContext = async (c: Context<{ Bindings: Env }>): Promise<ApolloContext> => {
  const env = c.env;
  const jwt = createJwtHelpers({ privateKey: env.JWT_PRIVATE_KEY, issuer: domain });
  const { userId, userEmail } = await authenticate(c.req.header('authorization')?.split(' ')[1], jwt.jwtVerify);
  return {
    env,
    clientIp: c.req.header('cf-connecting-ip') ?? 'unknown',
    userId,
    userEmail,
    retrieveUser: async () => (userEmail ? await env.USER.getByName(userEmail).get() : null),
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
