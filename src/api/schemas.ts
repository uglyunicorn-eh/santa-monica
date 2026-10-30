/**
 * Every shape the API reads or writes, as valibot schemas: request bodies, query strings, headers, the payloads of the
 * tokens it verifies, and every response. Input schemas bound and clean what a client sends; output
 * schemas turn stored records into the JSON the API answers with, and check it on the way out.
 */
import * as v from 'valibot';

import {
  DEFAULT_PAGE_SIZE, IDEMPOTENCY_KEY_RE, MAX_CURSOR_LENGTH, MAX_EMAIL_LENGTH, MAX_INVITES_PER_REQUEST, MAX_PAGE_SIZE,
  MAX_PARTY_NAME_LENGTH, MAX_PERSON_NAME_LENGTH, MAX_PHRASE_LENGTH,
  MAX_TOKEN_LENGTH, MIN_PAGE_SIZE, DUE_AT_MAX_MS, DUE_AT_MIN_MS,
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

/**
 * What mail apps turn into a link: a scheme (`https://`), `www.`, or a domain (`evil.co`, and so email addresses). One
 * letter before a dot (`J.R.R.`) or a space after it (`Mr. Smith`) isn't one.
 */
export const LINK_RE = /[a-z][a-z0-9+.-]*:\/\/|www\.|[a-z0-9-]{2,}\.[a-z]{2,}/i;

/**
 * Words a person typed: trimmed, runs of spaces collapsed, no space before punctuation; required, at most `max`. Names
 * go into emails sent to addresses a host typed (invites), so they can't hold a web address.
 */
const words = (label: string, max: number) => v.pipe(
  v.string(NOT_TEXT),
  v.trim(),
  v.transform((s: string) => s.replace(/\s+/g, ' ').replace(/\s([.,!?])/g, '$1')),
  v.nonEmpty(`${label} is required.`),
  v.maxLength(max, `${label} must be at most ${max} characters.`),
  v.check(text => !LINK_RE.test(text), `${label} can't contain a web address.`),
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

/** An encrypted token pasted from a link: length-limited before anything opens it. */
const token = v.pipe(
  v.string(NOT_TEXT),
  v.trim(),
  v.nonEmpty('Token is required.'),
  v.maxLength(MAX_TOKEN_LENGTH, `Token must be at most ${MAX_TOKEN_LENGTH} characters.`),
);

/** A party code, in either case. */
const partyCode = v.pipe(v.string(NOT_TEXT), v.trim(), v.toUpperCase(), v.regex(PARTY_CODE_RE, 'Invalid party code'));

/** A P-256 key coordinate in a JWK: 32 bytes, base64url. */
const jwkCoordinate = v.pipe(v.string('Invalid key.'), v.regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid key.'));

/**
 * The public key a browser binds its session to (src/utils/dpop.ts): a P-256 JWK with only its key fields, so
 * `exportKey('jwk')` output needs `ext` and `key_ops` taken off. Optional; left out or null reads as not given.
 */
const publicKey = v.pipe(
  v.nullish(v.strictObject({ kty: v.literal('EC', 'Invalid key.'), crv: v.literal('P-256', 'Invalid key.'), x: jwkCoordinate, y: jwkCoordinate }, 'Invalid key.')),
  v.transform(value => value ?? undefined),
);

/**
 * When a party is due (optional): an ISO 8601 date-time with its offset or Z, at least DUE_AT_MIN_MS and at most
 * DUE_AT_MAX_MS from now. Read as ms since the epoch; left out or null reads as none.
 */
const dueAt = v.pipe(
  v.nullish(v.pipe(
    v.string('Invalid due time.'),
    v.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/, 'Invalid due time.'),
    // Date.parse moves an impossible day (February 30) into the next month; refuse it instead.
    v.check(text => {
      const [year, month, day] = text.slice(0, 10).split('-').map(Number);
      return new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
    }, 'Invalid due time.'),
    v.transform(text => Date.parse(text)),
    v.check(ms => Number.isFinite(ms), 'Invalid due time.'),
    v.check(ms => ms >= Date.now() + DUE_AT_MIN_MS, 'The due time must be at least an hour from now.'),
    v.check(ms => ms <= Date.now() + DUE_AT_MAX_MS, 'The due time must be within a year.'),
  )),
  v.transform(value => value ?? undefined),
);

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
  // Sign-ins: the link, and the key to bind the new session to (optional until bound sessions are required).
  session: body({ token: required(token), key: publicKey }),
  link: body({ token: required(token) }),
  /** The email-change link, which signs in at the new address: it can bind the new session too. */
  signInLink: body({ token: required(token), key: publicKey }),
  profile: body({ name: required(words('Name', MAX_PERSON_NAME_LENGTH)) }),
  emailChange: v.pipe(body({ email: required(typedEmail) }), v.transform(normalizeEmail)),
  createParty: body({ name: required(words('Party name', MAX_PARTY_NAME_LENGTH)), password: optional(phrase), dueAt: dueAt }),
  // Party codes travel in a body, never in a URL (Cloudflare's request logs record URLs): the lookup and every write.
  joinParty: body({ code: required(partyCode), name: required(words('Name', MAX_PERSON_NAME_LENGTH)), password: optional(phrase) }),
  partyAction: body({ code: required(partyCode) }),
  /** An emailed invite, taken up: the link, the key to bind the session to, and what joining asks for. */
  acceptInvite: body({
    token: required(token), key: publicKey, name: required(words('Name', MAX_PERSON_NAME_LENGTH)), password: optional(phrase),
  }),
  invite: body({
    code: required(partyCode),
    emails: v.pipe(
      v.array(typedEmail, 'Must be a list of email addresses.'),
      v.minLength(1, 'Add at least one email address.'),
      v.maxLength(MAX_INVITES_PER_REQUEST, `You can invite up to ${MAX_INVITES_PER_REQUEST} people at a time.`),
    ),
  }),
  empty: body({}),
  /** A live-updates ticket: for the user's own updates, or with a party's code, for that party's. */
  liveTicket: body({ code: optional(partyCode) }),
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
    // A compact JWE with `dir` (src/utils/jwt.ts): header, empty key, IV, ciphertext and tag.
    v.regex(/^Bearer [\w-]+\.\.[\w-]+\.[\w-]+\.[\w-]+$/),
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
  user: v.object({
    sub: userNodeId, email: v.pipe(v.string(), v.nonEmpty()), ver: v.optional(v.number()), cnf: v.optional(v.object({ jkt: v.pipe(v.string(), v.nonEmpty()) })),
  }),
  enterRequest: v.object({ email: v.pipe(v.string(), v.nonEmpty(), v.toLowerCase()), typed: v.optional(v.string()), jti: linkId, exp: v.number(), party: v.optional(v.string()) }),
  partyInvite: v.object({ email: v.pipe(v.string(), v.nonEmpty(), v.toLowerCase()), party: v.pipe(v.string(), v.nonEmpty()), jti: linkId, exp: v.number() }),
  partySignIn: v.object({ sub: userNodeId, email: v.pipe(v.string(), v.nonEmpty()), party: v.pipe(v.string(), v.nonEmpty()), jti: linkId, exp: v.number() }),
  accountDeletion: v.object({ sub: userNodeId, email: v.pipe(v.string(), v.nonEmpty()), jti: linkId, exp: v.number(), ver: v.number() }),
  emailChange: v.object({
    sub: userNodeId, email: v.pipe(v.string(), v.nonEmpty()), newEmail: v.pipe(v.string(), v.nonEmpty()), jti: linkId, exp: v.number(), ver: v.number(),
  }),
  emailChangeCancel: v.object({ sub: userNodeId, email: v.pipe(v.string(), v.nonEmpty()), jti: linkId, exp: v.number() }),
  liveTicket: v.object({ sub: userNodeId, email: v.pipe(v.string(), v.nonEmpty()), ver: v.optional(v.number()), exp: v.number(), party: v.optional(v.string()) }),
};

// ---------------------------------------------------------------------------------------------------------------------
// Responses: stored records in, JSON out

/** A stored time (ms since the epoch) as the ISO 8601 string the API answers with. */
const iso = (ms: number) => new Date(ms).toISOString();
const isoString = v.pipe(v.string(), v.isoTimestamp());

const PartyCountsJson = v.object({ joined: v.number(), rolled: v.number(), hosted: v.number() });

/**
 * The signed-in user. The API never returns anyone else's. `joinedAt`: when the account was made. `parties`: how many
 * parties they're in, how many rolled, how many they host; only from GET and PATCH /v1/me, the profile.
 */
export const UserJson = v.object({
  id: v.string(),
  name: v.string(),
  email: v.string(),
  joinedAt: isoString,
  parties: v.optional(PartyCountsJson),
});

/** A stored user (UserRecord, or UserProfile with its party counts) as JSON. */
export const user = v.pipe(
  v.object({ id: v.string(), name: v.string(), email: v.string(), joined: v.number(), parties: v.optional(PartyCountsJson) }),
  v.transform(u => ({
    id: nodeIdToStr({ kind: 'User', id: u.id }),
    name: u.name,
    email: u.email,
    joinedAt: iso(u.joined),
    ...(u.parties && { parties: u.parties }),
  })),
  UserJson,
);

/** A sign-in: a session token and the user. */
/**
 * A new session. `expiresAt` is when the token stops working (the app can't read it: tokens are encrypted). `party` is
 * the party code a sign-in link was for, so the app can go there; null otherwise.
 */
export const session = v.object({ userToken: v.string(), user, expiresAt: isoString, party: v.nullish(v.string(), null) });

/** When a party was deleted, and until when it can be restored (a day, for parties deleted before that was kept). */
const deletionTimes = (deletedAt: number | null | undefined, restorableUntil: number | null | undefined) => ({
  deletedAt: deletedAt ? iso(deletedAt) : null,
  restorableUntil: deletedAt ? iso(restorableUntil ?? deletedAt + RESTORE_WINDOW_MS) : null,
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
  /** When the party is due, if the host set one: the app counts down to it. */
  dueAt: v.nullable(isoString),
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
    isClosed: v.boolean(), closedAt: v.nullable(v.number()), deletedAt: v.nullish(v.number()), restorableUntil: v.nullish(v.number()),
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
    ...deletionTimes(s.deletedAt, s.restorableUntil),
  })),
  PartySummaryJson,
);

/** A party view from the party (PartyView) as JSON. The draw's target is only ever a name. */
export const party = v.pipe(
  v.object({
    slug: v.string(), name: v.string(), password: v.nullable(v.string()), isProtected: v.boolean(),
    isHost: v.boolean(), isJoined: v.boolean(), isClosed: v.boolean(), createdAt: v.number(),
    closedAt: v.nullable(v.number()), deletedAt: v.nullable(v.number()), restorableUntil: v.nullish(v.number()), dueAt: v.nullish(v.number()),
    participantCount: v.nullable(v.number()),
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
    ...deletionTimes(p.deletedAt, p.restorableUntil),
    dueAt: p.dueAt ? iso(p.dueAt) : null,
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

/** The Party'o'meter: how many parties have rolled their dice. */
export const stats = v.object({ rolled: v.number() });

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

