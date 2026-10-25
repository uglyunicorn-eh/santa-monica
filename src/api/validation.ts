import * as yup from 'yup';

import { fail } from 'src/api/errors';
import {
  DEFAULT_PAGE_SIZE, MAX_CURSOR_LENGTH, MAX_EMAIL_LENGTH, MAX_NAME_LENGTH, MAX_PAGE_SIZE, MAX_PHRASE_LENGTH,
  MAX_TOKEN_LENGTH, MIN_PAGE_SIZE,
} from 'src/api/limits';
import { PARTY_CODE_RE } from 'src/api/party';
import * as YupHelpers from 'src/utils/yup/index';

const email = (label: string) => YupHelpers.string(label).email('Must be a valid email').max(MAX_EMAIL_LENGTH).required();
const token = YupHelpers.string('Token').max(MAX_TOKEN_LENGTH).required();
const name = (label: string) => YupHelpers.string(label).max(MAX_NAME_LENGTH).required();
const phrase = YupHelpers.password('Secret phrase').max(MAX_PHRASE_LENGTH);

export const schemas = {
  magicLink: yup.object({
    email: email('Email'),
    party: YupHelpers.string('Party Code').uppercase().matches(PARTY_CODE_RE, 'Invalid party code').notRequired(),
  }),
  session: yup.object({ token }),
  link: yup.object({ token }),
  profile: yup.object({ name: name('Name') }),
  emailChange: yup.object({ email: email('Email') }),
  createParty: yup.object({ name: name('Party name'), password: phrase }),
  joinParty: yup.object({ name: name('Name'), password: phrase }),
  empty: yup.object({}),
};

type Schema = yup.ObjectSchema<any>;

/**
 * Parses a JSON body against a schema. The body must be a JSON object (or empty, for a schema with no required
 * fields) holding only the schema's fields, each of them a string, within its length limit. Returns the cleaned
 * values (trimmed, spaces collapsed). Throws a 400 naming the first bad field.
 */
export async function parseBody<S extends Schema>(text: string, schema: S): Promise<yup.InferType<S>> {
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
  const fields = schema.fields as Record<string, unknown>;
  // null counts as leaving the field out, so a required field answers "required" rather than reaching the cleanup.
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in fields)) {
      throw fail('invalid', `Unknown field: ${key.slice(0, 50)}.`, key.slice(0, 50));
    }
    if (value === null) {
      continue;
    }
    if (typeof value !== 'string') {
      throw fail('invalid', 'Must be text.', key);
    }
    values[key] = value;
  }
  try {
    return await schema.validate(values, { abortEarly: true }) as yup.InferType<S>;
  } catch (error) {
    if (error instanceof yup.ValidationError) {
      throw fail('invalid', error.errors[0], error.path);
    }
    throw error;
  }
}

/** A party code from the path, in either case. Anything that isn't a code reads as a party that doesn't exist. */
export function partyCode(param: string | undefined): string {
  const code = (param ?? '').toUpperCase();
  if (!PARTY_CODE_RE.test(code)) {
    throw fail('not_found', 'Party does not exist.', 'party');
  }
  return code;
}

/** `first` from the query string: a whole number from MIN_PAGE_SIZE to MAX_PAGE_SIZE. */
export function pageSize(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  if (!/^\d{1,3}$/.test(value) || Number(value) < MIN_PAGE_SIZE || Number(value) > MAX_PAGE_SIZE) {
    throw fail('invalid', `Must be a whole number from ${MIN_PAGE_SIZE} to ${MAX_PAGE_SIZE}.`, 'first');
  }
  return Number(value);
}

/** `after` from the query string: a cursor from a previous page, length-limited before it is decoded. */
export function cursorParam(value: string | undefined): string | undefined {
  if (value !== undefined && (value.length === 0 || value.length > MAX_CURSOR_LENGTH)) {
    throw fail('invalid', 'Invalid cursor.', 'after');
  }
  return value;
}
