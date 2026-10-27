import { Hono } from 'hono';
import * as v from 'valibot';

import { adoptTypedAccount } from 'src/api/account';
import { action } from 'src/api/action';
import { ApiContext, ApiEnv, clientIp, jwtFor } from 'src/api/context';
import { fail } from 'src/api/errors';
import { idempotencyKey, keyHash, readBody, send } from 'src/api/input';
import { admitLegacyCode, emailRateLimit } from 'src/api/rateLimit';
import { forgetRequest, rememberRequest, seenRequest } from 'src/api/requestMemo';
import { accepted, bodies, session, tokens } from 'src/api/schemas';
import { EnterRequestToken } from 'src/api/types';
import { issueSession, sendRequestedMail } from 'src/api/users';
import { renderSignIn } from 'src/mail';
import { canonicalEmail, undottedGmail } from 'src/utils/email';
import { isExpiredToken } from 'src/utils/jwt';
import { partyRef } from 'src/utils/logRef';
import { annotate } from 'src/utils/tracing';

/** Magic links work for five minutes. */
const MAGIC_LINK_TTL = 300;

/** An expired sign-in link can still ask for a fresh one (`/magic-link/again`) for this long, in seconds. */
export const AGAIN_WITHIN_S = 7 * 24 * 60 * 60;

export const auth = new Hono<ApiEnv>();

/**
 * Emails a sign-in link to `email` (canonical), and stores nothing: everything the link needs travels inside it,
 * encrypted. A repeat of the same request (same Idempotency-Key and party) is remembered in this isolate's memory and
 * answered without sending or counting anything (src/api/requestMemo.ts). The account is made only when the link is
 * used (`POST /session`).
 */
async function sendSignInLink(c: ApiContext, { email, typed, party }: { email: string; typed: string; party?: string }) {
  const { env } = c;
  const detail = party ?? '';
  const key = idempotencyKey(c);
  // One request is the same key for the same address: another address with that key is a request of its own.
  const memo = key && `sign-in:${await keyHash(`${email}:${key}`)}`;
  annotate({ 'party.ref': party && await partyRef(env, party) });

  if (memo && seenRequest(memo, detail)) {
    annotate({ 'mail.request_repeated': true });
    return send(c, accepted, { ok: true }, 202);
  }
  if (memo) {
    rememberRequest(memo, detail);
  }
  try {
    return await sendNewSignInLink(c, { email, typed, party });
  } catch (error) {
    if (memo) {
      forgetRequest(memo, detail);
    }
    throw error;
  }
}

/** The limits, the party check and the email of `sendSignInLink`, once the request is claimed. */
async function sendNewSignInLink(c: ApiContext, { email, typed, party }: { email: string; typed: string; party?: string }) {
  const { env } = c;
  const rateLimited = await emailRateLimit(env, clientIp(c), email);
  annotate({ 'auth.rate_limited': rateLimited ?? false });
  if (rateLimited) {
    throw fail('rate_limited', "Whoa, that's a lot of magic links! Please wait a minute and try again.", 'email');
  }
  if (party) {
    await admitLegacyCode(env, clientIp(c), party, 'party');
  }
  if (party && !await env.PARTY.getByName(party).view()) {
    throw fail('not_found', 'Invalid party code.', 'party');
  }
  const token = await jwtFor(env).issueToken<EnterRequestToken>('EnterRequest', {
    email, ...(typed === email ? {} : { typed }), jti: crypto.randomUUID(), ...(party ? { party } : {}),
  }, { ttl: MAGIC_LINK_TTL });
  await sendRequestedMail(env, email, renderSignIn({ magicLink: `${env.FRONTEND_URL}/enter/link#${token}`, assetsUrl: env.PUBLIC_URL }), 'email', 'the magic link');
  return send(c, accepted, { ok: true }, 202);
}

/** Emails a magic link. With an Idempotency-Key, a repeat sends nothing and costs no rate limit. */
auth.post('/magic-link', action('enterRequest', async c => {
  const { email, typed, party } = await readBody(c, bodies.magicLink);
  return sendSignInLink(c, { email, typed, party });
}));

/**
 * Emails a fresh magic link for an expired one (up to AGAIN_WITHIN_S past its expiry), to the address inside it, with
 * the same party: the app can't read the link (it's encrypted), so it sends the link back instead of asking for the
 * address again. The same limits apply as for a new request.
 */
auth.post('/magic-link/again', action('enterRequestAgain', async c => {
  const { token } = await readBody(c, bodies.link);
  let payload: unknown;
  try {
    payload = await jwtFor(c.env).jwtVerify(token, 'EnterRequest', { expiredFor: AGAIN_WITHIN_S });
  } catch {
    payload = undefined;
  }
  const link = v.safeParse(tokens.enterRequest, payload);
  if (!link.success) {
    throw fail('invalid_link', 'Invalid request token.', 'token');
  }
  const email = canonicalEmail(link.output.email);
  return sendSignInLink(c, { email, typed: link.output.typed ?? link.output.email, party: link.output.party });
}));

/**
 * Signs in with a magic link. Each link works once; repeating the same request (same Idempotency-Key) signs in
 * again, so a retry after a dropped response doesn't strand the person. An account still kept under an older spelling
 * of the address moves to the normalized one first (`adoptTypedAccount`).
 */
auth.post('/session', action('enter', async c => {
  const { env } = c;
  const { token, key: publicKey } = await readBody(c, bodies.session);
  const key = await keyHash(idempotencyKey(c));
  const jwt = jwtFor(env);

  let payload: unknown;
  try {
    payload = await jwt.jwtVerify(token, 'EnterRequest');
  } catch (error) {
    if (isExpiredToken(error)) {
      annotate({ 'auth.magic_link': 'expired' });
      throw fail('link_expired', 'This magic link has expired. Please request a new one.', 'token');
    }
    payload = undefined;
  }
  const link = v.safeParse(tokens.enterRequest, payload);
  if (!link.success) {
    annotate({ 'auth.magic_link': 'invalid' });
    throw fail('invalid_link', 'Invalid request token.', 'token');
  }

  // Links sent before addresses were normalized carry the address as typed in `email`.
  const { jti, exp, typed = link.output.email } = link.output;
  const email = canonicalEmail(link.output.email);
  const older = [...new Set([typed, undottedGmail(email)])].filter((address): address is string => !!address && address !== email);
  if (older.length) {
    annotate({ 'auth.typed_account': await adoptTypedAccount(env, older, email, jti, exp * 1000, key) });
  }
  const user = await env.USER.getByName(email).redeemMagicLink(email, jti, exp * 1000, key);
  annotate({ 'auth.magic_link': user ? 'redeemed' : 'already_used', 'user.id': user?.id });
  if (!user) {
    throw fail('link_used', 'This magic link has already been used. Please request a new one.', 'token');
  }
  return send(c, session, { ...await issueSession(c.env, jwt, user, publicKey), party: link.output.party ?? null });
}));
