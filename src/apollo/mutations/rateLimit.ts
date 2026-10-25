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
