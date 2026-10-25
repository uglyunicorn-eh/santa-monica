import { fail } from 'src/api/errors';
import { Env } from 'src/env';

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
