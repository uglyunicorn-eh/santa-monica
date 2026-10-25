import { fail } from 'src/api/errors';
import type { MailQuota } from 'src/do/UserDO';
import { Env } from 'src/env';

/**
 * At most this many emails to one address per hour: sign-in links, account links, email-change links. Counted
 * exactly by the address's UserDO (`MAIL_QUOTA_WINDOW_MS`), on top of the approximate per-minute limits below. Kept
 * low, but not so low that someone who knows an address can lock its owner out for long: at worst for an hour.
 */
export const EMAILS_PER_ADDRESS_PER_HOUR = 6;

export const ADDRESS_QUOTA: MailQuota = { limit: EMAILS_PER_ADDRESS_PER_HOUR };

/** Counted against the address, but never refused: the notice to the current address about an email change. */
export const NOTICE_QUOTA: MailQuota = { limit: EMAILS_PER_ADDRESS_PER_HOUR, always: true };

export const tooManyForAddress = (field?: string) =>
  fail('rate_limited', "That's a lot of emails for this address. Please try again in an hour.", field);

/**
 * The limits for anything that sends an email (magic links, account confirmations): per client IP and per
 * recipient. Returns which one was hit, or undefined.
 */
export async function emailRateLimit(env: Env, clientIp: string, email: string): Promise<'ip' | 'email' | undefined> {
  const [byIp, byEmail] = await Promise.all([
    env.ENTER_RATE_LIMIT_IP.limit({ key: clientIp }),
    env.ENTER_RATE_LIMIT_EMAIL.limit({ key: email }),
  ]);
  return !byIp.success ? 'ip' : !byEmail.success ? 'email' : undefined;
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
