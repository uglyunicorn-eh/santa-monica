/**
 * Every shape the API reads or writes, as valibot schemas: request bodies, query strings, headers, the payloads of the
 * tokens it verifies, and every response. Input schemas bound and clean what a client sends; output
 * schemas turn stored records into the JSON the API answers with, and check it on the way out.
 */
import * as v from 'valibot';

import {
  DEFAULT_PAGE_SIZE, IDEMPOTENCY_KEY_RE, MAX_CURSOR_LENGTH, MAX_EMAIL_LENGTH, MAX_INVITES_PER_REQUEST, MAX_NAME_LENGTH, MAX_PAGE_SIZE, MAX_PHRASE_LENGTH,
  MAX_TOKEN_LENGTH, MIN_PAGE_SIZE,
} from 'src/api/limits';
import { RESTORE_WINDOW_MS } from 'src/do/PartyDO';
import type { PartyListCursor } from 'src/do/types';
import { canonicalEmail } from 'src/utils/email';
import { nodeIdToStr, strToNodeId } from 'src/utils/strings/nodeId';

export const PARTY_CODE_ALPHABET = 'QWERTYUIPASDFGHJKLZXCVBNMO';

/** New parties get 8-letter codes (26^8, about 2·10^11); parties made before that keep their 5-letter ones. */
export const PARTY_CODE_LENGTH = 8;
export const PARTY_CODE_RE = new RegExp(`^(?:[${PARTY_CODE_ALPHABET}]{5}|[${PARTY_CODE_ALPHABET}]{${PARTY_CODE_LENGTH}})$`);

// ---------------------------------------------------------------------------------------------------------------------
// Building blocks

const NOT_TEXT = 'Must be text.';

/** Words a person typed: trimmed, runs of spaces collapsed, no space before punctuation; required, at most `max`. */
const words = (label: string, max: number) => v.pipe(
  v.string(NOT_TEXT),
  v.trim(),
  v.transform((s: string) => s.replace(/\s+/g, ' ').replace(/\s([.,!?])/g, '$1')),
  v.nonEmpty(`${label} is required.`),
  v.maxLength(max, `${label} must be at most ${max} characters.`),
);

/** A secret phrase: trimmed only (inner spacing is part of it), at most MAX_PHRASE_LENGTH. */
const phrase = v.pipe(
  v.string(NOT_TEXT),
  v.trim(),
  v.maxLength(MAX_PHRASE_LENGTH, `Secret phrase must be at most ${MAX_PHRASE_LENGTH} characters.`),
);

/** An email address as typed, lowercased. */
const typedEmail = v.pipe(
  v.string(NOT_TEXT),
  v.trim(),
  v.nonEmpty('Email is required.'),
  v.maxLength(MAX_EMAIL_LENGTH, `Email must be at most ${MAX_EMAIL_LENGTH} characters.`),
  v.email('Must be a valid email'),
  v.toLowerCase(),
  v.check(address => canonicalEmail(address).indexOf('@') > 0, 'Must be a valid email'),
);

/** A signed token pasted from a link: length-limited before anything verifies it. */
const token = v.pipe(
  v.string(NOT_TEXT),
  v.trim(),
  v.nonEmpty('Token is required.'),
  v.maxLength(MAX_TOKEN_LENGTH, `Token must be at most ${MAX_TOKEN_LENGTH} characters.`),
);

/** A party code, in either case. */
const partyCode = v.pipe(v.string(NOT_TEXT), v.trim(), v.toUpperCase(), v.regex(PARTY_CODE_RE, 'Invalid party code'));

/** A required field: left out or null reads as empty, so the field's own "is required" message answers. */
const required = <S extends v.GenericSchema<string, unknown>>(schema: S) => v.nullish(schema, '');

/** An optional field: left out or null reads as not given. */
const optional = <S extends v.GenericSchema<string, unknown>>(schema: S) =>
  v.pipe(v.nullish(schema), v.transform(value => value ?? undefined));

/** A JSON body holding exactly these fields; any other field is refused by name. */
const body = <E extends v.ObjectEntries>(entries: E) =>
  v.strictObject(entries, issue => `Unknown field: ${String(v.getDotPath(issue)).slice(0, 50)}.`);

/**
 * Gives a body's `email` back as the address accounts are keyed by (`canonicalEmail`), and as `typed`: the address as
 * typed, lowercased, which older accounts may still be kept under.
 */
const normalizeEmail = <T extends { email: string }>(input: T) => ({ ...input, email: canonicalEmail(input.email), typed: input.email });

// ---------------------------------------------------------------------------------------------------------------------
// Request bodies

export const bodies = {
  magicLink: v.pipe(body({ email: required(typedEmail), party: optional(partyCode) }), v.transform(normalizeEmail)),
  session: body({ token: required(token) }),
  link: body({ token: required(token) }),
  profile: body({ name: required(words('Name', MAX_NAME_LENGTH)) }),
  emailChange: v.pipe(body({ email: required(typedEmail) }), v.transform(normalizeEmail)),
  createParty: body({ name: required(words('Party name', MAX_NAME_LENGTH)), password: optional(phrase) }),
  // Party codes travel in the body of every write, never in the URL: see `partyQuery`.
  joinParty: body({ code: required(partyCode), name: required(words('Name', MAX_NAME_LENGTH)), password: optional(phrase) }),
  partyAction: body({ code: required(partyCode) }),
  invite: body({
    code: required(partyCode),
    emails: v.pipe(
      v.array(typedEmail, 'Must be a list of email addresses.'),
      v.minLength(1, 'Add at least one email address.'),
      v.maxLength(MAX_INVITES_PER_REQUEST, `You can invite up to ${MAX_INVITES_PER_REQUEST} people at a time.`),
    ),
  }),
  empty: body({}),
};

// ---------------------------------------------------------------------------------------------------------------------
// Query strings, path params, headers

/** Cursors are opaque to clients: the last row's creation time and code, base64-encoded. */
export const encodeCursor = ({ createdAt, slug }: PartyListCursor) => btoa(`${createdAt}:${slug}`);

const INVALID_CURSOR = 'Invalid cursor.';

const cursor = v.pipe(
  v.string(INVALID_CURSOR),
  v.minLength(1, INVALID_CURSOR),
  v.maxLength(MAX_CURSOR_LENGTH, INVALID_CURSOR),
  v.rawTransform(({ dataset, addIssue, NEVER }) => {
    let match: RegExpExecArray | null = null;
    try {
      match = /^(\d{1,15}):([A-Z]{5,8})$/.exec(atob(dataset.value));
    } catch {
      // Not base64: reported below.
    }
    if (!match) {
      addIssue({ message: INVALID_CURSOR });
      return NEVER;
    }
    return { createdAt: Number(match[1]), slug: match[2] } satisfies PartyListCursor;
  }),
);

const PAGE_SIZE = `Must be a whole number from ${MIN_PAGE_SIZE} to ${MAX_PAGE_SIZE}.`;

export const queries = {
  /** `GET /v1/me/parties?first&after`. Other query parameters are ignored. */
  partyHistory: v.object({
    first: v.optional(v.pipe(
      v.string(PAGE_SIZE),
      v.regex(/^\d{1,3}$/, PAGE_SIZE),
      v.transform(Number),
      v.minValue(MIN_PAGE_SIZE, PAGE_SIZE),
      v.maxValue(MAX_PAGE_SIZE, PAGE_SIZE),
    ), String(DEFAULT_PAGE_SIZE)),
    after: v.optional(cursor),
  }),
};

/**
 * `GET /v1/parties?code=`: the one party route that can't take the code in a body. A party code lets anyone into a
 * party without a secret phrase, and Cloudflare's request logs and traces record request URLs, so it travels in the
 * query string, which they drop (`redact_query_string` in wrangler.jsonc), never in the path. Writes take it in the
 * body. Anything that isn't a party code reads as a party that doesn't exist.
 */
export const partyQuery = v.object({ code: v.pipe(v.string(), v.toUpperCase(), v.regex(PARTY_CODE_RE)) });

export const headers = {
  /** `Idempotency-Key`: optional, and refused when malformed rather than ignored. */
  idempotency: v.object({
    'idempotency-key': v.optional(v.pipe(
      v.string(),
      v.regex(IDEMPOTENCY_KEY_RE, 'Idempotency-Key must be 16 to 100 letters, digits, dashes or underscores.'),
    )),
  }),
  /** `Authorization: Bearer <token>`, length-limited. */
  bearer: v.pipe(
    v.string(),
    v.maxLength('Bearer '.length + MAX_TOKEN_LENGTH),
    v.regex(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/),
    v.transform((s: string) => s.slice('Bearer '.length)),
  ),
};

// ---------------------------------------------------------------------------------------------------------------------
// Token payloads (after the signature checks out)

/** A `User` node id, read as the internal user id. */
const userNodeId = v.pipe(
  v.string(),
  v.rawTransform(({ dataset, addIssue, NEVER }) => {
    try {
      const { kind, id } = strToNodeId(dataset.value);
      if (kind === 'User') {
        return id;
      }
    } catch {
      // Not a node id: reported below.
    }
    addIssue({ message: 'Not a user id.' });
    return NEVER;
  }),
);

const linkId = v.pipe(v.string(), v.nonEmpty());

export const tokens = {
  user: v.object({ sub: userNodeId, email: v.pipe(v.string(), v.nonEmpty()), ver: v.optional(v.number()) }),
  enterRequest: v.object({ email: v.pipe(v.string(), v.nonEmpty(), v.toLowerCase()), typed: v.optional(v.string()), jti: linkId, exp: v.number(), party: v.optional(v.string()) }),
  accountDeletion: v.object({ sub: userNodeId, email: v.pipe(v.string(), v.nonEmpty()), jti: linkId, exp: v.number(), ver: v.number() }),
  emailChange: v.object({
    sub: userNodeId, email: v.pipe(v.string(), v.nonEmpty()), newEmail: v.pipe(v.string(), v.nonEmpty()), jti: linkId, exp: v.number(), ver: v.number(),
  }),
  emailChangeCancel: v.object({ sub: userNodeId, email: v.pipe(v.string(), v.nonEmpty()), jti: linkId, exp: v.number() }),
  liveTicket: v.object({ sub: userNodeId, email: v.pipe(v.string(), v.nonEmpty()), ver: v.optional(v.number()), exp: v.number() }),
};

// ---------------------------------------------------------------------------------------------------------------------
// Responses: stored records in, JSON out

/** A stored time (ms since the epoch) as the ISO 8601 string the API answers with. */
const iso = (ms: number) => new Date(ms).toISOString();
const isoString = v.pipe(v.string(), v.isoTimestamp());

/** The signed-in user. The API never returns anyone else's. */
export const UserJson = v.object({ id: v.string(), name: v.string(), email: v.string() });

/** A stored user (UserRecord) as JSON. */
export const user = v.pipe(
  v.object({ id: v.string(), name: v.string(), email: v.string() }),
  v.transform(u => ({ id: nodeIdToStr({ kind: 'User', id: u.id }), name: u.name, email: u.email })),
  UserJson,
);

/** A sign-in: a session token and the user. */
export const session = v.object({ userToken: v.string(), user });

const deletionTimes = (deletedAt: number | null | undefined) => ({
  deletedAt: deletedAt ? iso(deletedAt) : null,
  restorableUntil: deletedAt ? iso(deletedAt + RESTORE_WINDOW_MS) : null,
});

/** A party in a list: what the user's own copy of it carries. */
export const PartySummaryJson = v.object({
  code: v.string(),
  name: v.string(),
  isHost: v.boolean(),
  isProtected: v.boolean(),
  isClosed: v.boolean(),
  isJoined: v.boolean(),
  createdAt: isoString,
  /** When the dice were rolled. Null while open, and for parties rolled before it was recorded. */
  rolledAt: v.nullable(isoString),
  /** When the host deleted it. Only the host sees a deleted party. */
  deletedAt: v.nullable(isoString),
  /** Until when the host can restore it. */
  restorableUntil: v.nullable(isoString),
});

/** A party as the asking person sees it. */
export const PartyJson = v.object({
  ...PartySummaryJson.entries,
  /** The secret phrase, for the host only. */
  password: v.nullable(v.string()),
  /** Only for members. */
  participantCount: v.nullable(v.number()),
  /** The host sees everyone; other members see up to three people besides themselves. */
  participants: v.nullable(v.array(v.string())),
  /** Who this person gives a gift to, once the dice are rolled: just a name. */
  target: v.nullable(v.object({ name: v.string() })),
});

/** A stored party summary (UserPartyRecord) as JSON. */
export const partySummary = v.pipe(
  v.object({
    slug: v.string(), name: v.string(), createdAt: v.number(), isHost: v.boolean(), isProtected: v.boolean(),
    isClosed: v.boolean(), closedAt: v.nullable(v.number()), deletedAt: v.nullish(v.number()),
  }),
  v.transform(s => ({
    code: s.slug,
    name: s.name,
    isHost: s.isHost,
    isProtected: s.isProtected,
    isClosed: s.isClosed,
    isJoined: true,
    createdAt: iso(s.createdAt),
    rolledAt: s.closedAt === null ? null : iso(s.closedAt),
    ...deletionTimes(s.deletedAt),
  })),
  PartySummaryJson,
);

/** A party view from the party (PartyView) as JSON. The draw's target is only ever a name. */
export const party = v.pipe(
  v.object({
    slug: v.string(), name: v.string(), password: v.nullable(v.string()), isProtected: v.boolean(),
    isHost: v.boolean(), isJoined: v.boolean(), isClosed: v.boolean(), createdAt: v.number(),
    closedAt: v.nullable(v.number()), deletedAt: v.nullable(v.number()), participantCount: v.nullable(v.number()),
    participants: v.nullable(v.array(v.string())), target: v.nullable(v.object({ name: v.string() })),
  }),
  v.transform(p => ({
    code: p.slug,
    name: p.name,
    isHost: p.isHost,
    isProtected: p.isProtected,
    isClosed: p.isClosed,
    isJoined: p.isJoined,
    createdAt: iso(p.createdAt),
    rolledAt: p.closedAt === null ? null : iso(p.closedAt),
    ...deletionTimes(p.deletedAt),
    password: p.password,
    participantCount: p.participantCount,
    participants: p.participants,
    target: p.target,
  })),
  PartyJson,
);

/** A page of the user's parties. */
export const partyPage = v.object({
  items: v.array(partySummary),
  hasMore: v.boolean(),
  endCursor: v.nullable(v.string()),
});

/** Rolled parties waiting for the user to reveal their name, as the home screen shows them. */
export const unrevealedParties = v.object({
  items: v.array(v.pipe(
    v.object({ slug: v.string(), name: v.string(), closedAt: v.number() }),
    v.transform(p => ({ code: p.slug, name: p.name, closedAt: iso(p.closedAt) })),
  )),
});

/** A ticket for opening a live-updates WebSocket. */
export const liveTicket = v.object({ ticket: v.string() });

/** `?ticket=` on a live-updates WebSocket request, length-limited before anything verifies it. */
export const liveQuery = v.object({ ticket: token });

/** A party invite's outcome, by address as typed. */
export const invites = v.object({
  invited: v.array(v.string()),
  alreadyInvited: v.array(v.string()),
  alreadyJoined: v.array(v.string()),
  invitesLeft: v.number(),
});

/** "Accepted": the email is on its way, or the request was already done. */
export const accepted = v.object({ ok: v.literal(true) });

/** The account an emailed link is for. */
export const linkAccount = v.object({ email: v.string() });

