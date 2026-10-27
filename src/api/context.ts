import { Context } from 'hono';

import { UserRecord } from 'src/do/types';
import { Env } from 'src/env';
import { JwtHelpers, createJwtHelpers } from 'src/utils/jwt';
import { Session, SessionProof } from 'src/utils/session';

import { domain } from 'src/config.json';

/** A signed-in request: who the token says it is. Only `verify()` (or a DO method given `session`) proves it still holds. */
export type RequestSession = Session & {
  userId: string;
  email: string;
  /** Reads the user and checks the token still belongs to them (one UserDO call, made once per request). */
  verify(): Promise<UserRecord | null>;
};

export type ApiEnv = {
  Bindings: Env;
  Variables: {
    session?: RequestSession;
    /** The log ref of the party a write is for, so the kept signed-out view of it is forgotten after (viewCache). */
    changedParty?: string;
  };
};

export type ApiContext = Context<ApiEnv>;

export const jwtFor = (env: Env): JwtHelpers => createJwtHelpers({ privateKey: env.JWT_PRIVATE_KEY, issuer: domain });

export const clientIp = (c: ApiContext) => c.req.header('cf-connecting-ip') ?? 'unknown';

export function makeSession(env: Env, userId: string, email: string, tokenVersion?: number, proof?: SessionProof): RequestSession {
  let verified: Promise<UserRecord | null> | undefined;
  return {
    userId,
    email,
    tokenVersion,
    ...(proof ? { proof } : {}),
    verify: () => {
      verified ??= env.USER.getByName(email).check({ userId, tokenVersion, proof });
      return verified;
    },
  };
}
