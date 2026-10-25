import { env, runDurableObjectAlarm } from 'cloudflare:test';

import { UserToken } from 'src/api/types';
import { app } from 'src/index';
import { createJwtHelpers } from 'src/utils/jwt';
import { nodeIdToStr } from 'src/utils/strings/nodeId';

import { domain } from 'src/config.json';

export const jwt = () => createJwtHelpers({ privateKey: env.JWT_PRIVATE_KEY, issuer: domain });

let counter = 0;

/** A unique address per call, so tests never share users or rate-limit buckets. */
export const uniqueEmail = (label = 'user') => `${label}-${Date.now().toString(36)}-${++counter}@example.com`;

export const allowed = { limit: async () => ({ success: true }) } as unknown as RateLimit;
export const denied = { limit: async () => ({ success: false }) } as unknown as RateLimit;

/** The test environment with every rate limit open, plus `overrides`. */
export const testEnv = (overrides: Partial<typeof env> = {}) => ({
  ...env,
  ENTER_RATE_LIMIT_IP: allowed,
  ENTER_RATE_LIMIT_EMAIL: allowed,
  PARTY_LOOKUP_RATE_LIMIT_IP: allowed,
  LEGACY_CODE_LOOKUP_RATE_LIMIT_IP: allowed,
  JOIN_RATE_LIMIT_USER: allowed,
  ...overrides,
}) as typeof env;

export type Sent = { to: string; subject: string; text: string }[];

/** An EMAIL binding that records what is sent (or fails, when `fail` says so). */
export function mailer(fail: (to: string) => boolean = () => false) {
  const sent: Sent = [];
  const EMAIL = {
    send: async (message: { to: string; subject: string; text: string }) => {
      if (fail(message.to)) {
        throw new Error('down');
      }
      sent.push({ to: message.to, subject: message.subject, text: message.text });
      return { messageId: 'm' };
    },
  } as unknown as SendEmail;
  return { sent, EMAIL };
}

export type RequestOptions = { body?: unknown; raw?: string; token?: string; key?: string; ip?: string; env?: typeof env };

/** Calls the app as a client would. Returns the status and the parsed body. */
export async function request<T = any>(method: string, path: string, options: RequestOptions = {}) {
  const res = await app.request(path, {
    method,
    headers: {
      'cf-connecting-ip': options.ip ?? `192.0.2.${++counter % 250}`,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.key ? { 'idempotency-key': options.key } : {}),
    },
    body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  }, options.env ?? testEnv());
  return { status: res.status, body: await res.json() as T, headers: res.headers };
}

/** A session token for a user id and email, with an optional token version. */
export const sessionToken = (id: string, email: string, ver?: number) =>
  jwt().issueToken<UserToken>('UserToken', { sub: nodeIdToStr({ kind: 'User', id }), email, ...(ver === undefined ? {} : { ver }) }, { ttl: 3600 });

/** Creates a user the way signing in does and returns a session token for it. */
export async function signIn(email: string = uniqueEmail(), name = '') {
  const user = await env.USER.getByName(email).ensure(email);
  if (name) {
    await env.USER.getByName(email).apply([{ type: 'setNameIfEmpty', name }]);
  }
  const sub = nodeIdToStr({ kind: 'User', id: user.id });
  const token = await jwt().issueToken<UserToken>('UserToken', { sub, email, ver: user.tokenVersion }, { ttl: 3600 });
  return { ...user, name, nodeId: sub, token, member: { id: user.id, email, name } };
}

/** Runs the party's alarm until its outbox is empty. The alarm may already be running on its own. */
export async function drainOutbox(slug: string) {
  const stub = env.PARTY.getByName(slug);
  for (let i = 0; i < 50; i++) {
    await runDurableObjectAlarm(stub);
    if (await stub.pendingOutbox() === 0) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Outbox of ${slug} did not drain`);
}
