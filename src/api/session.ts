import { createMiddleware } from 'hono/factory';
import * as v from 'valibot';

import { ApiEnv, jwtFor, makeSession } from 'src/api/context';
import { notSignedIn } from 'src/api/errors';
import { headers, tokens } from 'src/api/schemas';
import { Env } from 'src/env';

/**
 * The session the bearer token claims: the header must be a well-formed, length-limited `Bearer` token, its signature
 * must check out, and its payload must fit the session token schema (no DO call). Undefined for anything else.
 */
export async function authenticate(env: Env, header: string | undefined) {
  const bearer = v.safeParse(headers.bearer, header);
  if (!bearer.success) {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = await jwtFor(env).jwtVerify(bearer.output, 'UserToken');
  } catch {
    return undefined;
  }
  const claims = v.safeParse(tokens.user, payload);
  return claims.success ? makeSession(env, claims.output.sub, claims.output.email, claims.output.ver) : undefined;
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
