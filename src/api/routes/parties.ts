import { Hono } from 'hono';

import { action } from 'src/api/action';
import { ApiContext, ApiEnv, RequestSession, clientIp } from 'src/api/context';
import { fail, notSignedIn } from 'src/api/errors';
import { idempotencyKey, readBody, readParams, send } from 'src/api/input';
import { admitLegacyCode } from 'src/api/rateLimit';
import { PARTY_CODE_ALPHABET, PARTY_CODE_LENGTH, bodies, params, party as partyJson } from 'src/api/schemas';
import { optionalSession, requireSession } from 'src/api/session';
import { PartyResult, PartyView } from 'src/do/types';
import { newObjectId } from 'src/utils/ids';
import { randomString } from 'src/utils/strings/random';
import { partyRef } from 'src/utils/logRef';
import { annotate } from 'src/utils/tracing';

const SLUG_ATTEMPTS = 10;

/** How many open (not closed) parties one person can host at a time. */
export const MAX_OPEN_HOSTED_PARTIES = 3;

const tooManyOpenParties = (action: string) =>
  fail('conflict', `You can host up to ${MAX_OPEN_HOSTED_PARTIES} open parties at a time. Close or delete one of them to ${action}.`);

const notLoggedIn = (action: string) => fail('unauthenticated', `You must be logged in before ${action} the party.`);

/** A party's answer: the party as JSON, or its failure as the matching API error. */
function sendParty(c: ApiContext, result: PartyResult, status: 200 | 201 = 200) {
  if (!result.ok) {
    throw fail(result.error.code, result.error.message, result.error.fieldName ?? undefined);
  }
  return send(c, partyJson, result.view, status);
}

/** What someone without a (valid) session sees of a party: no membership details, and no deleted party at all. */
function anonymousView(view: PartyView): PartyView | null {
  if (view.deletedAt) {
    return null;
  }
  return { ...view, isHost: false, isJoined: false, password: null, participantCount: null, participants: null, target: null };
}

const session = (c: ApiContext): RequestSession => c.get('session')!;

/** Party codes are how a party without a secret phrase is reached, so looking them up is limited per client. */
async function admitLookup(c: ApiContext) {
  const { success } = await c.env.PARTY_LOOKUP_RATE_LIMIT_IP.limit({ key: clientIp(c) });
  if (!success) {
    throw fail('rate_limited', 'Too many party lookups. Please wait a minute and try again.');
  }
}

/** The session, proven to still belong to its user (one UserDO call), for routes whose party call can't check it. */
async function verified(c: ApiContext) {
  const user = await session(c).verify();
  if (!user) {
    throw notSignedIn();
  }
  return user;
}

export const parties = new Hono<ApiEnv>();

/**
 * Looks up a party by code. Anyone gets a limited view; members see more. A signed-in lookup checks the session at
 * the same time as it reads the party (one call each, in parallel); a revoked token sees what anyone sees.
 */
parties.get('/:code', optionalSession, action('party', async (c, span) => {
  const { code } = readParams(c, params.party);
  annotate({ 'party.ref': await partyRef(c.env, code) });
  await admitLookup(c);
  await admitLegacyCode(c.env, clientIp(c), code);
  const s = c.get('session');
  const stub = c.env.PARTY.getByName(code);
  const [view, user] = await Promise.all([stub.view(s?.userId), s ? s.verify() : null]);
  const seen = view && (user ? view : anonymousView(view));
  span.setAttributes({ 'party.found': Boolean(seen), 'party.joined': seen?.isJoined });
  if (!seen) {
    throw fail('not_found', 'Party does not exist.', 'party');
  }
  return send(c, partyJson, seen);
}));

/**
 * Creates a party with the signed-in user as host. One UserDO call reads the host's name, checks the session and the
 * open-party limit, and holds a slot. With an Idempotency-Key, a repeat for the same name returns the same party.
 */
parties.post('/', requireSession, action('createParty', async c => {
  const input = await readBody(c, bodies.createParty);
  const s = session(c);
  const key = idempotencyKey(c);
  annotate({ 'party.protected': Boolean(input.password) });
  const userDO = c.env.USER.getByName(s.email);
  let id = newObjectId();
  let slug = randomString(PARTY_CODE_LENGTH, PARTY_CODE_ALPHABET);
  const user = await userDO.startHosting(MAX_OPEN_HOSTED_PARTIES, s, key ? { key, id, slug, detail: input.name } : undefined);
  if (!user) {
    throw notLoggedIn('creating');
  }
  annotate({ 'user.open_hosted_parties': user.openHostedParties });
  if (!user.allowed) {
    throw tooManyOpenParties('start a new one');
  }
  if (user.request) {
    ({ id, slug } = user.request);
  }
  // A repeated request holds no slot. It only gets the party the first one made: on a conflict that party is gone
  // (deleted) or still being placed under another code by the first request, so a repeat never picks a new code.
  const repeated = !user.reservation;
  annotate({ 'party.request_repeated': repeated });
  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      slug = randomString(PARTY_CODE_LENGTH, PARTY_CODE_ALPHABET);
      if (key) {
        await userDO.retargetRequest(key, slug);
      }
    }
    const result = await c.env.PARTY.getByName(slug).create({
      id,
      slug,
      name: input.name,
      password: input.password || null,
      host: { id: user.id, email: s.email, name: user.name },
      reservation: user.reservation,
    });
    annotate({ 'party.code_attempts': attempt + 1 });
    if ('conflict' in result) {
      if (repeated) {
        throw fail('conflict', 'This party is no longer available. Please start a new one.');
      }
      continue;
    }
    annotate({ 'party.ref': await partyRef(c.env, slug) });
    return sendParty(c, result, 201);
  }
  throw new Error('Unable to generate a unique party code.');
}));

/**
 * Joins a party. The member comes from the session token and the name from the form; the party checks the session
 * in the call it makes to the user anyway. Joining twice keeps one membership.
 */
parties.post('/:code/join', requireSession, action('joinParty', async c => {
  const { code } = readParams(c, params.party);
  const { name, password } = await readBody(c, bodies.joinParty);
  const s = session(c);
  annotate({ 'party.ref': await partyRef(c.env, code) });
  // Joining with a code is how a party without a secret phrase is reached, so attempts are limited per user.
  const { success } = await c.env.JOIN_RATE_LIMIT_USER.limit({ key: s.userId });
  annotate({ 'party.join_rate_limited': !success });
  if (!success) {
    throw fail('rate_limited', "Whoa, that's a lot of tries! Please wait a minute and try again.", 'party');
  }
  await admitLegacyCode(c.env, clientIp(c), code, 'party');
  return sendParty(c, await c.env.PARTY.getByName(code).join(
    { id: s.userId, email: s.email, name },
    name,
    password || null,
    { tokenVersion: s.tokenVersion },
  ));
}));

/** Leaves a party. Leaving one you're not in answers with the party as it is. */
parties.post('/:code/leave', requireSession, action('leaveParty', async c => {
  const { code } = readParams(c, params.party);
  annotate({ 'party.ref': await partyRef(c.env, code) });
  const user = await verified(c);
  return sendParty(c, await c.env.PARTY.getByName(code).leave(user.id));
}));

/** Rolls the dice (host only). A repeat answers with the same draw; nothing is drawn or mailed again. */
parties.post('/:code/draw', requireSession, action('closeParty', async c => {
  const { code } = readParams(c, params.party);
  annotate({ 'party.ref': await partyRef(c.env, code) });
  const user = await verified(c);
  return sendParty(c, await c.env.PARTY.getByName(code).close(user.id));
}));

/** Deletes an open party (host only); it can be restored for a day. A repeat answers with the deleted party. */
parties.delete('/:code', requireSession, action('deleteParty', async c => {
  const { code } = readParams(c, params.party);
  annotate({ 'party.ref': await partyRef(c.env, code) });
  const user = await verified(c);
  return sendParty(c, await c.env.PARTY.getByName(code).delete(user.id));
}));

/**
 * Restores a deleted party (host only). An open party counts towards the host's limit again, so a slot is held for
 * it first, which also checks the session; otherwise the session is checked on its own. A repeat answers with the
 * party as it is, holding no slot.
 */
parties.post('/:code/restore', requireSession, action('restoreParty', async c => {
  const { code } = readParams(c, params.party);
  annotate({ 'party.ref': await partyRef(c.env, code) });
  const s = session(c);
  const stub = c.env.PARTY.getByName(code);
  const view = await stub.view(s.userId);
  let reservation: string | undefined;
  if (view?.deletedAt && !view.isClosed) {
    const hosting = await c.env.USER.getByName(s.email).startHosting(MAX_OPEN_HOSTED_PARTIES, s);
    if (!hosting) {
      throw notLoggedIn('restoring');
    }
    if (!hosting.allowed) {
      throw tooManyOpenParties('restore this one');
    }
    reservation = hosting.reservation;
  } else {
    await verified(c);
  }
  return sendParty(c, await stub.restore(s.userId, reservation));
}));
