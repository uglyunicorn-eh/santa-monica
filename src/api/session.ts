import { createMiddleware } from 'hono/factory';
import * as v from 'valibot';

import { ApiContext, ApiEnv, jwtFor, makeSession } from 'src/api/context';
import { fail, notSignedIn } from 'src/api/errors';
import { headers, tokens } from 'src/api/schemas';
import { Env } from 'src/env';
import { checkProof, proofId } from 'src/utils/dpop';
import { SessionProof } from 'src/utils/session';

/** The response header that gives the Worker's time (seconds since the epoch) when a proof's clock is off. */
export const DPOP_TIME_HEADER = 'DPoP-Time';

/**
 * What a bound token's proof is checked against: the request it came with. `records`: the proof is recorded, so it
 * works only once (see `authenticate`).
 */
export type ProofRequest = { method: string; url: string; dpop?: string; records?: boolean };

/**
 * The request's proof details, for `authenticate`. A proof is recorded only on routes that change something: signed-in
 * routes other than GET. Reads (GET routes, and the optional-session lookups) check it but don't write for it, so a
 * proof copied with its token can re-send that one read, to that URL, within its minute, but never a write.
 */
export const proofRequest = (c: ApiContext, records: boolean): ProofRequest =>
  ({ method: c.req.method, url: c.req.url, dpop: c.req.header('dpop'), records: records && c.req.method !== 'GET' });

/** Whether tokens not bound to a key are refused (`REQUIRE_BOUND_SESSIONS`, see wrangler.jsonc). */
export const requiresBoundSessions = (env: Env) => env.REQUIRE_BOUND_SESSIONS === 'true';

/**
 * The session the bearer token claims: the header must be a well-formed, length-limited `Bearer` token, its signature
 * must check out, and its payload must fit the session token schema (no DO call). A token bound
 * to a key (`cnf.jkt`) also needs a valid DPoP proof for this request (src/utils/dpop.ts), and once
 * REQUIRE_BOUND_SESSIONS is on, only bound tokens count. Undefined for anything else, and `skewed` when the only thing
 * wrong is the proof's clock. On a write (`request.records`), a bound session carries its proof's id, so the UserDO
 * check that every signed-in route makes also refuses a proof sent twice.
 */
export async function authenticate(env: Env, header: string | undefined, request?: ProofRequest) {
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
  if (!claims.success) {
    return undefined;
  }
  const jkt = claims.output.cnf?.jkt;
  let proof: SessionProof | undefined;
  if (jkt) {
    const check = request ? await checkProof(request.dpop, { method: request.method, url: request.url, token: bearer.output, jkt }) : 'missing';
    if (check === 'skewed') {
      return 'skewed' as const;
    }
    if (check !== 'ok') {
      return undefined;
    }
    // On a write, the user's object lets the proof work for this request only (UserDO.holds).
    if (request!.records) {
      proof = { ...proofId(request!.dpop!), request: crypto.randomUUID() };
    }
  } else if (requiresBoundSessions(env)) {
    return undefined;
  }
  return makeSession(env, claims.output.sub, claims.output.email, claims.output.ver, proof);
}

/**
 * A proof that only fails on its clock: 400 with the Worker's time, so the app can correct its clock and retry. Never
 * 401, which signs the app out: a laptop with a wrong clock would be signed out on every request.
 */
function clockSkewed(c: ApiContext) {
  c.header(DPOP_TIME_HEADER, String(Math.floor(Date.now() / 1000)));
  return fail('invalid', "Your device's clock seems to be off. Please check it and try again.", 'DPoP');
}

/**
 * Routes that need a session: 401 without a valid token. Whether the token was revoked is checked by the route,
 * either with `session.verify()` or inside the DO call it makes anyway (methods that take a `Session`).
 */
export const requireSession = createMiddleware<ApiEnv>(async (c, next) => {
  const session = await authenticate(c.env, c.req.header('authorization'), proofRequest(c, true));
  if (session === 'skewed') {
    throw clockSkewed(c);
  }
  if (!session) {
    throw notSignedIn();
  }
  c.set('session', session);
  await next();
});

/** Routes that work signed in or not. A token (or proof) that doesn't verify counts as no session; a skewed clock is 400. */
export const optionalSession = createMiddleware<ApiEnv>(async (c, next) => {
  const session = await authenticate(c.env, c.req.header('authorization'), proofRequest(c, false));
  if (session === 'skewed') {
    throw clockSkewed(c);
  }
  c.set('session', session);
  await next();
});
