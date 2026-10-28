import { ApiError } from 'src/api/errors';
import { Env } from 'src/env';
import { mailRef, partyRef } from 'src/utils/logRef';
import { annotate } from 'src/utils/tracing';

// Every Cloudflare rate limit the API uses, and the one way they're checked. `take` counts a use and says whether it
// was let through; `admit` counts it and refuses with a 429 that says when to try again. Limits are checked one at a
// time, broadest first (per client, then per user or address, then all emails together), and a later one is counted
// only when the ones before let the request through, so a request refused by one never uses up another. A refusal is
// recorded on the trace as `rate_limit.hit`, the same attribute for every limit. Limits that the Durable Objects count
// exactly (wrong phrases, new parties a day, open parties, invites per party) are rules of their own, answered there.

/** The Rate Limiting bindings, as named in wrangler.jsonc and src/env.ts. Each counts over one minute. */
export type Limit =
  | 'ENTER_RATE_LIMIT_IP'
  | 'MAIL_RATE_LIMIT_ADDRESS'
  | 'MAIL_RATE_LIMIT_ALL'
  | 'PARTY_LOOKUP_RATE_LIMIT_IP'
  | 'LEGACY_CODE_LOOKUP_RATE_LIMIT_IP'
  | 'JOIN_RATE_LIMIT_USER'
  | 'INVITE_RATE_LIMIT_USER'
  | 'STATS_WATCH_RATE_LIMIT_IP';

/** When to try again after one of these limits, in seconds (`Retry-After`): every one counts over a minute. */
export const RETRY_AFTER_S = 60;

/** What a refused request is told: the message, and the form field it's about, if any. */
export type Refusal = { message: string; field?: string };

/** Every refusal, in one place. */
export const REFUSALS = {
  signInLinks: { message: "Whoa, that's a lot of magic links! Please wait a minute and try again.", field: 'email' },
  accountEmails: { message: "Whoa, that's a lot of emails! Please wait a minute and try again." },
  partyCodes: (field: string): Refusal => ({ message: 'Too many party lookups. Please wait a minute and try again.', field }),
  oldPartyCodes: (field: string): Refusal => ({ message: 'Too many tries with this kind of party code. Please wait a minute and try again.', field }),
  joins: { message: "Whoa, that's a lot of tries! Please wait a minute and try again.", field: 'party' },
  invites: { message: "That's a lot of invites at once. Please wait a minute and try again.", field: 'emails' },
  sockets: { message: 'Too many connections. Please wait a minute and try again.' },
} satisfies Record<string, Refusal | ((field: string) => Refusal)>;

/** A 429 for `refusal`, with `Retry-After` (src/index.ts sets the header). */
export const tooMany = (refusal: Refusal) => new ApiError('rate_limited', refusal.message, refusal.field, RETRY_AFTER_S);

/** Counts one use of `limit` for `key`. False when it's used up, which is recorded on the trace. */
export async function take(env: Env, limit: Limit, key: string): Promise<boolean> {
  const { success } = await env[limit].limit({ key });
  if (!success) {
    annotate({ 'rate_limit.hit': limit });
  }
  return success;
}

/** Counts one use of `limit` for `key`, and refuses the request with a 429 when it's used up. */
export async function admit(env: Env, limit: Limit, key: string, refusal: Refusal) {
  if (!await take(env, limit, key)) {
    throw tooMany(refusal);
  }
}

/** The key of the limit on all emails together (`MAIL_RATE_LIMIT_ALL`). */
export const ALL_MAIL = 'all';

/**
 * Admits an email someone asked for (sign-in links, account links): per client IP, then per recipient
 * (`takeAddressLimit`). The limit on all emails together is taken later, by `takeAllMail`, right before it goes out.
 */
export async function admitEmail(env: Env, clientIp: string, email: string, refusal: Refusal) {
  await admit(env, 'ENTER_RATE_LIMIT_IP', clientIp, refusal);
  if (!await takeAddressLimit(env, email)) {
    throw tooMany(refusal);
  }
}

/**
 * Counts one email to `email` (canonical) against its limit, about 3 a minute (`MAIL_RATE_LIMIT_ADDRESS`), keyed by
 * the address's hash (`mailRef`). False when it's used up. This is the only per-address limit, and it stores nothing:
 * an address that never signs in leaves nothing behind. The notice of an email change to the current address is never
 * limited (src/api/routes/me.ts), so a burst of requests can't hold it back.
 */
export async function takeAddressLimit(env: Env, email: string): Promise<boolean> {
  return take(env, 'MAIL_RATE_LIMIT_ADDRESS', await mailRef(env, email));
}

/**
 * Counts one email against the limit on all of them together, right before it is sent: requested emails
 * (`sendRequestedMail`) and party invites (`PartyDO`). False when it's used up. A backstop against a spike or a spam
 * run using up the sending quota, counted per Cloudflare location and roughly, like every Rate Limiting binding. It is
 * taken only once every other check has passed, so requests refused for another reason don't use it up for everyone.
 */
export async function takeAllMail(env: Env): Promise<boolean> {
  return take(env, 'MAIL_RATE_LIMIT_ALL', ALL_MAIL);
}

/** Old parties kept their 5-letter codes. */
export const LEGACY_CODE_LENGTH = 5;

/**
 * The stricter limit for trying old 5-letter party codes, per client IP. New 8-letter codes aren't counted. Throws a
 * 429 when it's reached.
 */
export async function admitLegacyCode(env: Env, clientIp: string, code: string, field: string) {
  if (code.length === LEGACY_CODE_LENGTH) {
    await admit(env, 'LEGACY_CODE_LOOKUP_RATE_LIMIT_IP', clientIp, REFUSALS.oldPartyCodes(field));
  }
}

/**
 * Party codes are how a party without a secret phrase is reached, and any route that takes one tells whether it
 * exists. So every one of them is limited per client: 60 codes a minute, 10 for old 5-letter codes. Returns the
 * code's log ref (also put on the trace).
 */
export async function admitPartyCode(env: Env, clientIp: string, code: string, field = 'party'): Promise<string> {
  const ref = await partyRef(env, code);
  annotate({ 'party.ref': ref });
  await admit(env, 'PARTY_LOOKUP_RATE_LIMIT_IP', clientIp, REFUSALS.partyCodes(field));
  await admitLegacyCode(env, clientIp, code, field);
  return ref;
}
