import { fail } from 'src/api/errors';
import { Env } from 'src/env';
import { mailRef, partyRef } from 'src/utils/logRef';
import { annotate } from 'src/utils/tracing';

/** The key of the limit on all emails together (`MAIL_RATE_LIMIT_ALL`). */
export const ALL_MAIL = 'all';

/**
 * The limits for anything that sends an email (magic links, account links): per client IP, and per recipient
 * (`takeAddressLimit`). Returns which one was hit, or undefined. The limit on all emails together is taken later, by
 * `takeAllMail`, right before an email goes out.
 */
export async function emailRateLimit(env: Env, clientIp: string, email: string): Promise<'ip' | 'email' | undefined> {
  const [byIp, byAddress] = await Promise.all([
    env.ENTER_RATE_LIMIT_IP.limit({ key: clientIp }),
    takeAddressLimit(env, email),
  ]);
  return !byIp.success ? 'ip' : !byAddress ? 'email' : undefined;
}

/**
 * Counts one email to `email` (canonical) against its limit, about 3 a minute (`MAIL_RATE_LIMIT_ADDRESS`), keyed by
 * the address's hash (`mailRef`). False when it's used up. This is the only per-address limit, and it stores nothing:
 * an address that never signs in leaves nothing behind. The notice of an email change to the current address is never
 * limited (src/api/routes/me.ts), so a burst of requests can't hold it back.
 */
export async function takeAddressLimit(env: Env, email: string): Promise<boolean> {
  return (await env.MAIL_RATE_LIMIT_ADDRESS.limit({ key: await mailRef(env, email) })).success;
}

/**
 * Counts one email against the limit on all of them together, right before it is sent: requested emails
 * (`sendRequestedMail`) and party invites (`PartyDO`). False when it's used up. A backstop against a spike or a spam
 * run using up the sending quota, counted per Cloudflare location and roughly, like every Rate Limiting binding. It is
 * taken only once every other check has passed, so requests refused for another reason don't use it up for everyone.
 */
export async function takeAllMail(env: Env): Promise<boolean> {
  return (await env.MAIL_RATE_LIMIT_ALL.limit({ key: ALL_MAIL })).success;
}

/** Old parties kept their 5-letter codes. */
export const LEGACY_CODE_LENGTH = 5;

/**
 * The stricter limit for trying old 5-letter party codes, per client IP. New 8-letter codes aren't counted. Throws a
 * 429 when it's reached.
 */
export async function admitLegacyCode(env: Env, clientIp: string, code: string, field?: string) {
  if (code.length !== LEGACY_CODE_LENGTH) {
    return;
  }
  const { success } = await env.LEGACY_CODE_LOOKUP_RATE_LIMIT_IP.limit({ key: clientIp });
  if (!success) {
    throw fail('rate_limited', 'Too many tries with this kind of party code. Please wait a minute and try again.', field);
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
  const { success } = await env.PARTY_LOOKUP_RATE_LIMIT_IP.limit({ key: clientIp });
  if (!success) {
    throw fail('rate_limited', 'Too many party lookups. Please wait a minute and try again.', field);
  }
  await admitLegacyCode(env, clientIp, code, field);
  return ref;
}
