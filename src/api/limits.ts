/**
 * Bounds for everything a client can send. Every input has one: body size, each string, each number, each header we
 * read. The frontend (santa-barbara's src/limits.ts) uses the same numbers for its forms, so keep them in sync.
 */

/** Largest request body accepted. The biggest request the frontend makes is well under 1 KB. */
export const MAX_BODY_BYTES = 16 * 1024;

/** A person's name: in their profile, and the name they join a party with. */
export const MAX_PERSON_NAME_LENGTH = 32;
/** A party's name. */
export const MAX_PARTY_NAME_LENGTH = 48;
/** Secret phrases. */
export const MAX_PHRASE_LENGTH = 100;
export const MAX_EMAIL_LENGTH = 128;
/** Addresses in one party invite request. */
export const MAX_INVITES_PER_REQUEST = 10;
/** Signed tokens: sessions, magic links and the account email links. Ours are a few hundred characters. */
export const MAX_TOKEN_LENGTH = 2048;
/** Paging cursors from `GET /v1/me/parties`. Ours are about 32 characters. */
export const MAX_CURSOR_LENGTH = 100;

/** Page sizes for party lists. */
export const MIN_PAGE_SIZE = 1;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 10;

/** `Idempotency-Key` header: a client-made id, such as a UUID. */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,100}$/;

/** A party's due time is at least this far ahead when it's set (an hour)... */
export const DUE_AT_MIN_MS = 60 * 60 * 1000;
/** ...and at most this far (a year and a day). */
export const DUE_AT_MAX_MS = 366 * 24 * 60 * 60 * 1000;
