import * as v from 'valibot';

import { ApiContext } from 'src/api/context';
import { ErrorCode, fail } from 'src/api/errors';
import { headers, partyQuery } from 'src/api/schemas';

/** Runs a schema over client input. The first problem becomes the error, naming the field it is about. */
function check<S extends v.GenericSchema>(schema: S, value: unknown, code: ErrorCode = 'invalid', message?: string, field?: string): v.InferOutput<S> {
  const result = v.safeParse(schema, value, { abortEarly: true });
  if (result.success) {
    return result.output;
  }
  const issue = result.issues[0];
  throw fail(code, message ?? issue.message, field ?? v.getDotPath(issue) ?? undefined);
}

/**
 * The request body, read against a body schema. It must be JSON (or empty, for a schema with no required fields)
 * and a JSON object; the schema then refuses unknown fields, non-text values and anything over its limits.
 */
export async function readBody<S extends v.GenericSchema>(c: ApiContext, schema: S): Promise<v.InferOutput<S>> {
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw fail('invalid', 'The request body must be JSON.');
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw fail('invalid', 'The request body must be a JSON object.');
  }
  return check(schema, raw);
}

/** The query string, read against a query schema. */
export const readQuery = <S extends v.GenericSchema>(c: ApiContext, schema: S): v.InferOutput<S> => check(schema, c.req.query());

/** The party a party route is about, from `?code=`. A missing or malformed code names a party that doesn't exist. */
export const readPartyCode = (c: ApiContext): string =>
  check(partyQuery, c.req.query(), 'not_found', 'Party does not exist.', 'party').code;

/**
 * The request's `Idempotency-Key`, if it sent one. Repeating a request with the same key (for ten minutes) gives the
 * same result without doing the work again. A malformed key is refused rather than ignored, so a client never
 * believes a request is protected when it isn't.
 */
export const idempotencyKey = (c: ApiContext): string | undefined =>
  check(headers.idempotency, { 'idempotency-key': c.req.header('idempotency-key') }, 'invalid', undefined, 'Idempotency-Key')['idempotency-key'];

/** Links remember the key they were first used with as a hash, so a stored key can't be replayed from storage. */
export async function keyHash(key: string | undefined): Promise<string | undefined> {
  if (!key) {
    return undefined;
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Answers with `data` shaped by an output schema. Data that doesn't fit is a bug: it fails the request (500). */
export const send = <S extends v.GenericSchema>(c: ApiContext, schema: S, data: v.InferInput<S>, status: 200 | 201 | 202 = 200) =>
  c.json(v.parse(schema, data), status);
