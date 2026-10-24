import { BaseContext } from '@apollo/server';
import { Context } from 'hono';

import { UserRecord } from 'src/do/types';
import { Env } from 'src/env';
import { MailMessage, sendMail } from 'src/mail';
import { JwtHelpers, createJwtHelpers } from 'src/utils/jwt';

import { domain } from 'src/config.json';

export interface ApolloContext extends BaseContext, JwtHelpers {
  env: Env;
  clientIp: string;
  authToken?: string;
  auth?: Promise<void>;
  userId?: string;
  userEmail?: string;
  retrieveUser: () => Promise<UserRecord | null>;
  sendMail: (to: string, message: MailMessage) => Promise<void>;
};

export const makeContext = async (c: Context<{ Bindings: Env }>): Promise<ApolloContext> => {
  const env = c.env;
  return {
    env,
    clientIp: c.req.header('cf-connecting-ip') ?? 'unknown',
    authToken: c.req.header('authorization')?.split(' ')[1],
    userId: undefined,
    userEmail: undefined,
    retrieveUser: async () => { throw new Error("Unable to retrieve user"); },
    sendMail: (to, message) => sendMail(env, to, message),
    ...createJwtHelpers({ privateKey: env.JWT_PRIVATE_KEY, issuer: domain }),
  };
};
