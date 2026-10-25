import { createMiddleware } from 'hono/factory';

import { ApiEnv, jwtFor, makeSession } from 'src/api/context';
import { notSignedIn } from 'src/api/errors';
import { MAX_TOKEN_LENGTH } from 'src/api/limits';
import { UserToken } from 'src/api/types';
import { Env } from 'src/env';
import { strToNodeId } from 'src/utils/strings/nodeId';

/** The session the bearer token claims, with its signature checked (no DO call). Undefined for anything else. */
export async function authenticate(env: Env, header: string | undefined) {
  const match = header && /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(header);
  if (!match || match[1].length > MAX_TOKEN_LENGTH) {
    return undefined;
  }
  try {
    const { sub, email, ver } = await jwtFor(env).jwtVerify<UserToken>(match[1], 'UserToken');
    const { kind, id } = strToNodeId(sub);
    if (kind !== 'User' || !email || (ver !== undefined && typeof ver !== 'number')) {
      return undefined;
    }
    return makeSession(env, id, email, ver);
  } catch {
    return undefined;
  }
}

/**
 * Routes that need a session: 401 without a valid token. Whether the token was revoked is checked by the route,
 * either with `session.verify()` or inside the DO call it makes anyway (methods that take a `Session`).
 */
export const requireSession = createMiddleware<ApiEnv>(async (c, next) => {
  const session = await authenticate(c.env, c.req.header('authorization'));
  if (!session) {
    throw notSignedIn();
  }
  c.set('session', session);
  await next();
});

/** Routes that work signed in or not. A token that doesn't verify counts as no session. */
export const optionalSession = createMiddleware<ApiEnv>(async (c, next) => {
  c.set('session', await authenticate(c.env, c.req.header('authorization')));
  await next();
});
