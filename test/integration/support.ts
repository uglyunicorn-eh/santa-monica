import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { expect } from 'vitest';

import { EnterRequestToken, UserToken } from 'src/api/types';
import { createJwtHelpers } from 'src/utils/jwt';

import { domain } from 'src/config.json';

export const ORIGIN = 'https://api.test';
/** Where emailed links point in tests (FRONTEND_URL in vitest.config.ts). */
export const FRONTEND = 'https://gnomik.me';

export type Mail = {
  messageId: string;
  to: string[];
  from: { email: string; name: string } | string;
  subject: string;
  html: string | null;
  text: string | null;
  sentAt: number;
};

let counter = 0;

/** A unique address per call, so tests never share users, rate-limit buckets or mailboxes. */
export const uniqueEmail = (label = 'user') => `${label}-${Date.now().toString(36)}-${++counter}@example.com`;

export const uniqueIp = () => `10.${(counter >> 16) & 255}.${(counter >> 8) & 255}.${++counter & 255}`;

/** A fresh Idempotency-Key. */
export const newKey = () => crypto.randomUUID();

/** Sends a request through the Worker's real entry point (Hono app, Durable Objects). */
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return await (exports as any).default.fetch(new Request(new URL(path, ORIGIN), init));
}

export type CallOptions = { body?: unknown; token?: string; key?: string; ip?: string; headers?: Record<string, string> };

/** Calls the API the way the frontend does and returns the status with the parsed JSON body. */
export async function call<T = any>(method: string, path: string, options: CallOptions = {}): Promise<{ status: number; body: T }> {
  const res = await api(path, {
    method,
    headers: {
      'cf-connecting-ip': options.ip ?? uniqueIp(),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.key ? { 'idempotency-key': options.key } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: res.status, body: await res.json() as T };
}

/** The error body an expected failure answers with. */
export const apiError = (code: string, message?: string, field?: string) => ({
  error: { code, ...(message === undefined ? {} : { message }), ...(field === undefined ? {} : { field }) },
});

/** All mail delivered to an address, oldest first. */
export async function mailbox(email: string): Promise<Mail[]> {
  const kv = (env as unknown as { TEST_MAILS: KVNamespace }).TEST_MAILS;
  const { keys } = await kv.list({ prefix: `${email.toLowerCase()}/` });
  const mails = await Promise.all(keys.map(async ({ name }) => JSON.parse((await kv.get(name))!) as Mail));
  return mails.sort((a, b) => a.sentAt - b.sentAt);
}

/** The token at the end of an emailed link to `path` (e.g. "enter", "profile/delete", "profile/email"). */
export function linkToken(mail: Mail, path: string): string {
  const match = new RegExp(`${FRONTEND.replace(/[.]/g, '\\.')}/${path}/([\\w-]+\\.[\\w-]+\\.[\\w-]+)`).exec(mail.text ?? '');
  if (!match) {
    throw new Error(`No ${path} link in the email`);
  }
  return match[1];
}

export const magicLinkToken = (mail: Mail) => linkToken(mail, 'enter');

export const requestMagicLink = (email: string, options: CallOptions & { party?: string } = {}) =>
  call('POST', '/v1/auth/magic-link', { ...options, body: { email, ...(options.party ? { party: options.party } : {}) } });

export const redeem = (token: string, options: CallOptions = {}) =>
  call('POST', '/v1/auth/session', { ...options, body: { token } });

/** Signs in the way a person does: request a magic link, read the email, follow the link. */
export async function signIn(email: string, party?: string) {
  const before = (await mailbox(email)).length;
  const requested = await requestMagicLink(email, { party });
  if (requested.status !== 202) {
    throw new Error(`magic link failed: ${JSON.stringify(requested.body)}`);
  }
  const mails = await mailbox(email);
  if (mails.length !== before + 1) {
    throw new Error(`Expected one new sign-in email for ${email}, got ${mails.length - before}`);
  }
  const entered = await redeem(magicLinkToken(mails.at(-1)!));
  const { userToken, user } = entered.body;
  return { email: email.toLowerCase(), token: userToken as string, id: user.id as string };
}

export type Person = Awaited<ReturnType<typeof signIn>>;

export const jwt = (privateKey: string = env.JWT_PRIVATE_KEY) => createJwtHelpers({ privateKey, issuer: domain });

export const mintEnterRequestToken = (payload: EnterRequestToken, ttl = 300, secret?: string) =>
  jwt(secret).issueToken<EnterRequestToken>('EnterRequest', payload, { ttl });

export const mintUserToken = (payload: UserToken, ttl = 3600, secret?: string) =>
  jwt(secret).issueToken<UserToken>('UserToken', payload, { ttl });

/** Runs a party's alarm until its outbox is empty, or until `attempts` runs have been made. */
export async function settleParty(code: string, attempts = 50) {
  const stub = env.PARTY.getByName(code);
  for (let i = 0; i < attempts; i++) {
    await runDurableObjectAlarm(stub);
    if (await stub.pendingOutbox() === 0) {
      return 0;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return await stub.pendingOutbox();
}

export type PartyJson = {
  code: string;
  name: string;
  password: string | null;
  isJoined: boolean;
  isHost: boolean;
  isProtected: boolean;
  isClosed: boolean;
  createdAt: string;
  rolledAt: string | null;
  deletedAt: string | null;
  restorableUntil: string | null;
  participantCount: number | null;
  participants: string[] | null;
  target: { name: string } | null;
};

export async function createParty(host: Person, name = 'Office party', password: string | null = null, key?: string) {
  const res = await call<PartyJson>('POST', '/v1/parties', { token: host.token, key, body: { name, ...(password === null ? {} : { password }) } });
  if (res.status !== 201) {
    throw new Error(`createParty failed: ${JSON.stringify(res)}`);
  }
  return res.body;
}

export const viewParty = (code: string, person?: { token: string }) => call<PartyJson>('GET', `/v1/parties?code=${code}`, { token: person?.token });

export const joinParty = (person: { token: string }, party: { code: string }, name: string, password: string | null = null) =>
  call<PartyJson>('POST', '/v1/parties/join', { token: person.token, body: { code: party.code, name, ...(password === null ? {} : { password }) } });

export const leaveParty = (person: { token: string }, party: { code: string }) =>
  call<PartyJson>('POST', '/v1/parties/leave', { body: { code: party.code }, token: person.token });

export const drawParty = (person: { token: string }, party: { code: string }) =>
  call<PartyJson>('POST', '/v1/parties/draw', { body: { code: party.code }, token: person.token });

export const deleteParty = (person: { token: string }, party: { code: string }) =>
  call<PartyJson>('POST', '/v1/parties/delete', { body: { code: party.code }, token: person.token });

export const restoreParty = (person: { token: string }, party: { code: string }) =>
  call<PartyJson>('POST', '/v1/parties/restore', { body: { code: party.code }, token: person.token });

export const myParties = (person: { token?: string }, query = '') =>
  call<{ items: PartyJson[]; hasMore: boolean; endCursor: string | null }>('GET', `/v1/me/parties${query}`, { token: person.token });

export const me = (person: { token?: string }) => call('GET', '/v1/me', { token: person.token });

/** Asks for the account deletion link and returns its token, read from the email. */
export async function requestDeletion(person: Person, key?: string) {
  const res = await call('POST', '/v1/me/deletion', { token: person.token, key });
  expect(res).toMatchObject({ status: 202 });
  return linkToken((await mailbox(person.email)).at(-1)!, 'profile/delete');
}

export const confirmDeletion = (token: string, options: CallOptions = {}) =>
  call('POST', '/v1/me/deletion/confirm', { ...options, body: { token } });

/** Asks to move the account to `newEmail` and returns the confirmation link's token, read from the new mailbox. */
export async function requestEmailChange(person: Person, newEmail: string, key?: string) {
  const res = await call('POST', '/v1/me/email-change', { token: person.token, key, body: { email: newEmail } });
  expect(res).toMatchObject({ status: 202 });
  return linkToken((await mailbox(newEmail)).at(-1)!, 'profile/email');
}

export const confirmEmailChange = (token: string, options: CallOptions = {}) =>
  call('POST', '/v1/me/email-change/confirm', { ...options, body: { token } });

/** Moves the person's account to a new address through the emails, and returns them as they are afterwards. */
export async function changeEmail(person: Person, newEmail: string): Promise<Person> {
  const token = await requestEmailChange(person, newEmail);
  const res = await confirmEmailChange(token);
  expect(res.status).toBe(200);
  return { email: newEmail.toLowerCase(), token: res.body.userToken, id: res.body.user.id };
}

/** Deletes the person's account through the emails. */
export async function deleteAccount(person: Person) {
  const res = await confirmDeletion(await requestDeletion(person));
  expect(res).toMatchObject({ status: 200 });
}

/** Moves a time column in a DO table `ms` into the past, for time windows (links, restore windows). */
export async function ageRows(stub: DurableObjectStub, table: string, column: string, ms: number) {
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(`UPDATE ${table} SET ${column} = ${column} - ?`, ms);
  });
}
