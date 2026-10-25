import { Hono } from 'hono';
import * as v from 'valibot';

import { action } from 'src/api/action';
import { ApiEnv, clientIp, jwtFor } from 'src/api/context';
import { fail } from 'src/api/errors';
import { idempotencyKey, keyHash, readBody, send } from 'src/api/input';
import { emailRateLimit } from 'src/api/rateLimit';
import { accepted, bodies, session, tokens } from 'src/api/schemas';
import { EnterRequestToken } from 'src/api/types';
import { issueSession, sendRequestedMail } from 'src/api/users';
import { renderSignIn } from 'src/mail';
import { annotate } from 'src/utils/tracing';

/** Magic links work for five minutes. */
const MAGIC_LINK_TTL = 300;

export const auth = new Hono<ApiEnv>();

/**
 * Emails a magic link. With an Idempotency-Key, a repeat sends nothing and costs no rate limit: the key is looked up
 * first (read only), then the limits run, and only then is it claimed, so nobody can fill an address's storage with
 * keys for free.
 */
auth.post('/magic-link', action('enterRequest', async c => {
  const { env } = c;
  const { email, party } = await readBody(c, bodies.magicLink);
  const key = idempotencyKey(c);
  const detail = party ?? '';
  const recipient = env.USER.getByName(email);
  annotate({ 'party.code': party });

  if (key && await recipient.seenMailRequest(key, detail)) {
    annotate({ 'mail.request_repeated': true });
    return send(c, accepted, { ok: true }, 202);
  }
  const rateLimited = await emailRateLimit(env, clientIp(c), email);
  annotate({ 'auth.rate_limited': rateLimited ?? false });
  if (rateLimited) {
    throw fail('rate_limited', "Whoa, that's a lot of magic links! Please wait a minute and try again.", 'email');
  }
  if (party && !await env.PARTY.getByName(party).view()) {
    throw fail('not_found', 'Invalid party code.', 'party');
  }
  if (key && !await recipient.claimMailRequest(key, detail)) {
    // The same request got here first, a moment ago.
    return send(c, accepted, { ok: true }, 202);
  }

  const jwt = jwtFor(env);
  const token = await jwt.issueToken<EnterRequestToken>('EnterRequest', {
    email, jti: crypto.randomUUID(), ...(party ? { party } : {}),
  }, { ttl: MAGIC_LINK_TTL });
  try {
    await sendRequestedMail(env, email, renderSignIn({ magicLink: `${env.FRONTEND_URL}/enter/${token}`, assetsUrl: env.PUBLIC_URL }), 'email', 'the magic link');
  } catch (error) {
    if (key) {
      await recipient.releaseMailRequest(key, detail);
    }
    throw error;
  }
  return send(c, accepted, { ok: true }, 202);
}));

/**
 * Signs in with a magic link. Each link works once; repeating the same request (same Idempotency-Key) signs in
 * again, so a retry after a dropped response doesn't strand the person.
 */
auth.post('/session', action('enter', async c => {
  const { env } = c;
  const { token } = await readBody(c, bodies.session);
  const key = await keyHash(idempotencyKey(c));
  const jwt = jwtFor(env);

  let payload: unknown;
  try {
    payload = await jwt.jwtVerify(token, 'EnterRequest');
  } catch {
    payload = undefined;
  }
  const link = v.safeParse(tokens.enterRequest, payload);
  if (!link.success) {
    annotate({ 'auth.magic_link': 'invalid' });
    throw fail('invalid_link', 'Invalid request token.', 'token');
  }

  const { email, jti, exp } = link.output;
  const user = await env.USER.getByName(email).redeemMagicLink(email, jti, exp * 1000, key);
  annotate({ 'auth.magic_link': user ? 'redeemed' : 'already_used', 'user.id': user?.id });
  if (!user) {
    throw fail('link_used', 'This magic link has already been used. Please request a new one.', 'token');
  }
  return send(c, session, await issueSession(jwt, user));
}));
