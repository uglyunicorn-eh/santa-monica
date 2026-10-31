import { Hono } from 'hono';
import * as v from 'valibot';

import { adoptTypedAccount } from 'src/api/account';
import { action } from 'src/api/action';
import { ApiContext, ApiEnv, clientIp, jwtFor } from 'src/api/context';
import { fail } from 'src/api/errors';
import { idempotencyKey, keyHash, readBody, send } from 'src/api/input';
import { REFUSALS, admitEmail, admitLegacyCode } from 'src/api/rateLimit';
import { forgetRequest, rememberRequest, seenRequest } from 'src/api/requestMemo';
import { accepted, bodies, session, tokens } from 'src/api/schemas';
import { EnterRequestToken } from 'src/api/types';
import { issueSession, sendRequestedMail } from 'src/api/users';
import { UserRecord } from 'src/do/types';
import { Env } from 'src/env';
import { renderSignIn } from 'src/mail';
import { canonicalEmail, undottedGmail } from 'src/utils/email';
import { JwtHelpers, TokenType, isExpiredToken } from 'src/utils/jwt';
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
  await admitEmail(env, clientIp(c), email, REFUSALS.signInLinks);
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
  const jwt = jwtFor(c.env);
  const link = v.safeParse(tokens.enterRequest, await payloadOf(jwt, token, 'EnterRequest', AGAIN_WITHIN_S));
  if (link.success) {
    const email = canonicalEmail(link.output.email);
    return sendSignInLink(c, { email, typed: link.output.typed ?? link.output.email, party: link.output.party });
  }
  // An expired invite asks the same way, and gets a magic link for its party (the address in it is already normalized).
  const invite = v.safeParse(tokens.partyInvite, await payloadOf(jwt, token, 'PartyInvite', AGAIN_WITHIN_S));
  if (invite.success) {
    return sendSignInLink(c, { email: invite.output.email, typed: invite.output.email, party: invite.output.party });
  }
  // So does a member's expired party link, but only while the account it was for is still at its address, as the link
  // itself checks: a drawn party keeps a member's old address after an email change, and a magic link there would make
  // a new, empty account. The address may be an older spelling: the magic link signs in the usual way (`/session`),
  // which moves such an account first.
  const member = v.safeParse(tokens.partySignIn, await payloadOf(jwt, token, 'PartySignIn', AGAIN_WITHIN_S));
  if (!member.success) {
    throw fail('invalid_link', 'Invalid request token.', 'token');
  }
  const { sub: userId, email, party } = member.output;
  const held = await askMemberAddresses<'ok' | 'busy'>(email, async address => c.env.USER.getByName(address).holdsMember(userId));
  if (held !== 'ok') {
    annotate({ 'auth.party_link': held });
    throw memberLinkRefused[held]();
  }
  return sendSignInLink(c, { email: canonicalEmail(email), typed: email, party });
}));

/** What a link of `type` says, accepting one expired up to `expiredFor` seconds ago; undefined when it doesn't open. */
async function payloadOf(jwt: JwtHelpers, token: string, type: TokenType, expiredFor: number): Promise<unknown> {
  try {
    return await jwt.jwtVerify(token, type, { expiredFor });
  } catch {
    return undefined;
  }
}

/**
 * Opens an emailed link of `type` and reads it with `schema`. Refuses an expired one as `link_expired` (saying
 * `expired`) and anything else that doesn't open as `invalid_link`, recording which on the trace as `trace`.
 */
async function openLink<S extends v.GenericSchema>(
  jwt: JwtHelpers, token: string, type: TokenType, schema: S, trace: string, expired: string,
): Promise<v.InferOutput<S>> {
  let payload: unknown;
  try {
    payload = await jwt.jwtVerify(token, type);
  } catch (error) {
    if (isExpiredToken(error)) {
      annotate({ [trace]: 'expired' });
      throw fail('link_expired', expired, 'token');
    }
  }
  const link = v.safeParse(schema, payload);
  if (!link.success) {
    annotate({ [trace]: 'invalid' });
    throw fail('invalid_link', 'Invalid request token.', 'token');
  }
  return link.output;
}

/**
 * An account kept under an older spelling of `email` (`typed`, or the Gmail address without its dots) moves to it
 * first (`adoptTypedAccount`), so signing in with `link` lands there.
 */
async function adoptOlder(env: Env, email: string, link: { jti: string; exp: number }, key?: string, typed = email) {
  const older = [...new Set([typed, undottedGmail(email)])].filter((address): address is string => !!address && address !== email);
  if (older.length) {
    annotate({ 'auth.typed_account': await adoptTypedAccount(env, older, email, link.jti, link.exp * 1000, key) });
  }
}

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
  const link = await openLink(jwt, token, 'EnterRequest', tokens.enterRequest, 'auth.magic_link', 'This magic link has expired. Please request a new one.');

  // Links sent before addresses were normalized carry the address as typed in `email`.
  const { jti, exp, typed = link.email } = link;
  const email = canonicalEmail(link.email);
  await adoptOlder(env, email, link, key, typed);
  const user = await env.USER.getByName(email).redeemMagicLink(email, jti, exp * 1000, key);
  annotate({ 'auth.magic_link': user ? 'redeemed' : 'already_used', 'user.id': user?.id });
  if (!user) {
    throw fail('link_used', 'This magic link has already been used. Please request a new one.', 'token');
  }
  return send(c, session, { ...await issueSession(c.env, jwt, user, publicKey), party: link.party ?? null });
}));

/**
 * Takes up an emailed party invite: signs the invited address in and joins the party, in one step, with the name (and
 * secret phrase) the person typed. The account is the address's own, made now if it has none, as with a magic link.
 *
 * The link is used up only once the party says they can join, so a wrong phrase can be fixed and tried again; the
 * party counts wrong phrases per address. It signs in only to join: someone who is already a member is emailed a
 * magic link for the party instead (202), so an invite that's old or forwarded doesn't open their account. Repeating
 * the request (same Idempotency-Key) signs in again. If the join fails after the link is used (the dice were rolled
 * just then), the person is still signed in, and the party they see says why.
 */
auth.post('/invite', action('acceptInvite', async c => {
  const { env } = c;
  const { token, key: publicKey, name, password } = await readBody(c, bodies.acceptInvite);
  const key = await keyHash(idempotencyKey(c));
  const jwt = jwtFor(env);
  const link = await openLink(jwt, token, 'PartyInvite', tokens.partyInvite, 'auth.invite', 'This invite has expired. We can send you a fresh link.');
  const { email, party: code, jti, exp } = link;
  annotate({ 'party.ref': await partyRef(env, code) });
  const party = env.PARTY.getByName(code);
  const userDO = env.USER.getByName(email);
  const signedIn = async (user: UserRecord) => send(c, session, { ...await issueSession(env, jwt, user, publicKey), party: code });

  const admitted = await party.admitInvitee(email, password ?? null);
  if (!admitted.ok) {
    annotate({ 'auth.invite': 'refused' });
    // Every refusal names its field ('party' or 'password').
    throw fail(admitted.error.code, admitted.error.message, admitted.error.fieldName!);
  }
  if (admitted.member) {
    // Only a repeat of the request that joined them (its answer was lost) signs a member in.
    const user = key ? await userDO.redeemedBy(jti, key) : null;
    annotate({ 'auth.invite': user ? 'repeated' : 'member' });
    return user ? signedIn(user) : sendSignInLink(c, { email, typed: email, party: code });
  }

  await adoptOlder(env, email, link, key);
  const user = await userDO.redeemMagicLink(email, jti, exp * 1000, key);
  annotate({ 'auth.invite': user ? 'redeemed' : 'already_used', 'user.id': user?.id });
  if (!user) {
    throw fail('link_used', 'This invite has already been used. Please sign in with your email to join.', 'token');
  }
  const joined = await party.join({ id: user.id, email, name }, name, password ?? null, { tokenVersion: user.tokenVersion });
  annotate({ 'party.joined': joined.ok });
  return signedIn(user);
}));

/** How a party's sign-in link (or a fresh link asked for an expired one) is refused, by reason. */
const memberLinkRefused = {
  not_member: () => fail('not_member', 'This link is not for an account in this party. Please sign in with your email.', 'token'),
  used: () => fail('link_used', 'This link has already been used. Please sign in with your email.', 'token'),
  busy: () => fail('account_busy', 'Another change to this account is in progress. Please try again in a minute.', 'token'),
};

/**
 * Asks the account at a member's address, then at its normalized spelling when that differs (a party keeps the address
 * its member joined with, and an account saved under an older spelling moves to the normalized one on sign-in), until
 * one says it's theirs.
 */
async function askMemberAddresses<T>(email: string, ask: (address: string) => Promise<T | 'not_member'>): Promise<T | 'not_member'> {
  let answer: T | 'not_member' = 'not_member';
  for (const address of new Set([email, canonicalEmail(email)])) {
    answer = await ask(address);
    if (answer !== 'not_member') {
      break;
    }
  }
  return answer;
}

/**
 * Signs a member in with the link in a party's email (the "dice are rolled" email, or the host's reminder the day
 * before), and returns the party with the session. It signs in only the member it was sent to (`sub`), and only while
 * they're still in the party and the account at the address (or its normalized spelling) is still theirs. Otherwise
 * it's refused as `not_member` (`account_busy` while the account is being changed) and left unused, so the app falls
 * back to signing in by email; it never makes or moves an account. Each link works once; repeating the same request
 * (same Idempotency-Key) signs in again.
 */
auth.post('/party-link', action('partySignIn', async c => {
  const { env } = c;
  const { token, key: publicKey } = await readBody(c, bodies.session);
  const key = await keyHash(idempotencyKey(c));
  const jwt = jwtFor(env);
  const link = await openLink(jwt, token, 'PartySignIn', tokens.partySignIn, 'auth.party_link', 'This link has expired. We can send you a fresh one.');
  const { sub: userId, email, party: code, jti, exp } = link;
  annotate({ 'party.ref': await partyRef(env, code), 'user.id': userId });

  const user = await env.PARTY.getByName(code).hasMember(userId)
    ? await askMemberAddresses<UserRecord | 'used' | 'busy'>(email, async address => env.USER.getByName(address).redeemMemberLink(userId, jti, exp * 1000, key))
    : 'not_member';
  if (typeof user === 'string') {
    annotate({ 'auth.party_link': user });
    throw memberLinkRefused[user]();
  }
  annotate({ 'auth.party_link': 'redeemed' });
  return send(c, session, { ...await issueSession(env, jwt, user, publicKey), party: code });
}));
