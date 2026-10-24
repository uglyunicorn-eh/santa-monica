import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';

import { EnterRequestToken, UserToken } from 'src/apollo/types';
import { createJwtHelpers } from 'src/utils/jwt';

import { domain } from 'src/config.json';

export const ORIGIN = 'https://api.test';

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

const uniqueIp = () => `10.${(counter >> 16) & 255}.${(counter >> 8) & 255}.${++counter & 255}`;

/** Sends a request through the Worker's real entry point (Sentry wrapper, Hono app, Durable Objects). */
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return await (exports as any).default.fetch(new Request(new URL(path, ORIGIN), init));
}

export type GqlOptions = { token?: string; ip?: string };

export async function gql<T = any>(query: string, variables: Record<string, unknown> = {}, options: GqlOptions = {}) {
  const res = await api('/graph', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': options.ip ?? uniqueIp(),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  return await res.json() as { data: T; errors?: { message: string }[] };
}

/** All mail delivered to an address, oldest first. */
export async function mailbox(email: string): Promise<Mail[]> {
  const kv = (env as unknown as { TEST_MAILS: KVNamespace }).TEST_MAILS;
  const { keys } = await kv.list({ prefix: `${email.toLowerCase()}/` });
  const mails = await Promise.all(keys.map(async ({ name }) => JSON.parse((await kv.get(name))!) as Mail));
  return mails.sort((a, b) => a.sentAt - b.sentAt);
}

export const ENTER_REQUEST = `
  mutation ($email: String!, $party: String) {
    auth { enterRequest(input: { email: $email, party: $party }) { status userErrors { fieldName messages } } }
  }`;

export const ENTER = `
  mutation ($token: String!) {
    auth { enter(input: { enterRequestToken: $token }) { status userErrors { fieldName messages } userToken user { id name } } }
  }`;

/** Extracts the magic-link token from a sign-in email (the link is https://gnomik.me/enter/<token>). */
export function magicLinkToken(mail: Mail): string {
  const match = /https:\/\/gnomik\.me\/enter\/([\w-]+\.[\w-]+\.[\w-]+)/.exec(mail.text ?? '');
  if (!match) {
    throw new Error('No magic link in the email');
  }
  return match[1];
}

/** Signs in the way a person does: request a magic link, read the email, follow the link. */
export async function signInWithMagicLink(email: string, party?: string) {
  const before = (await mailbox(email)).length;
  const requested = await gql(ENTER_REQUEST, { email, party });
  if (requested.data.auth.enterRequest.status !== 'ok') {
    throw new Error(`enterRequest failed: ${JSON.stringify(requested.data.auth.enterRequest.userErrors)}`);
  }
  const mails = await mailbox(email);
  if (mails.length !== before + 1) {
    throw new Error(`Expected one new sign-in email for ${email}, got ${mails.length - before}`);
  }
  const entered = await gql(ENTER, { token: magicLinkToken(mails.at(-1)!) });
  const { userToken, user } = entered.data.auth.enter;
  return { email, token: userToken as string, id: user.id as string };
}

export type Person = Awaited<ReturnType<typeof signInWithMagicLink>>;

export const jwt = (secret: string = env.JWT_SECRET) => createJwtHelpers({ secret, issuer: domain });

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

export const PARTY_FIELDS = `
  id name code password isJoined isHost isProtected isClosed participantCount participants target { id name }`;

export const CREATE_PARTY = `
  mutation ($name: String!, $password: String) {
    parties { createParty(input: { name: $name, password: $password }) { status userErrors { fieldName messages } node { ${PARTY_FIELDS} } } }
  }`;

export const JOIN_PARTY = `
  mutation ($party: ID!, $name: String!, $password: String) {
    parties { joinParty(input: { party: $party, name: $name, password: $password }) { status userErrors { fieldName messages } node { ${PARTY_FIELDS} } } }
  }`;

export const LEAVE_PARTY = `
  mutation ($party: ID!) {
    parties { leaveParty(input: { party: $party }) { status userErrors { fieldName messages } node { ${PARTY_FIELDS} } } }
  }`;

export const CLOSE_PARTY = `
  mutation ($party: ID!) {
    parties { closeParty(input: { party: $party }) { status userErrors { fieldName messages } node { ${PARTY_FIELDS} } } }
  }`;

export const PARTY = `query ($code: String!) { party(code: $code) { ${PARTY_FIELDS} } }`;

export const PARTIES = `query ($first: Int) { parties(first: $first) { code name isHost isJoined } }`;

export async function createParty(host: Person, name = 'Office party', password: string | null = null) {
  const res = await gql(CREATE_PARTY, { name, ...(password === null ? {} : { password }) }, { token: host.token });
  if (res.data?.parties.createParty.status !== 'ok') {
    throw new Error(`createParty failed: ${JSON.stringify(res)}`);
  }
  return res.data.parties.createParty.node as { id: string; code: string; name: string };
}

export async function joinParty(person: Person, party: { id: string }, name: string, password: string | null = null) {
  const res = await gql(JOIN_PARTY, { party: party.id, name, ...(password === null ? {} : { password }) }, { token: person.token });
  return res.data.parties.joinParty;
}
