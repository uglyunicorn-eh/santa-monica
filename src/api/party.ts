import { fail } from 'src/api/errors';
import { RESTORE_WINDOW_MS } from 'src/do/PartyDO';
import { PartyListCursor, PartyView, UserPartyListItem, UserPartyRecord } from 'src/do/types';
import { Env } from 'src/env';
import { Session } from 'src/utils/session';

export const PARTY_CODE_ALPHABET = 'QWERTYUIPASDFGHJKLZXCVBNMO';

/** New parties get 8-letter codes (26^8, about 2·10^11); parties made before that keep their 5-letter ones. */
export const PARTY_CODE_LENGTH = 8;
export const PARTY_CODE_RE = new RegExp(`^(?:[${PARTY_CODE_ALPHABET}]{5}|[${PARTY_CODE_ALPHABET}]{${PARTY_CODE_LENGTH}})$`);

/** A party in a list: what the user's own copy of it carries. */
export type PartySummaryJson = {
  code: string;
  name: string;
  isHost: boolean;
  isProtected: boolean;
  isClosed: boolean;
  isJoined: boolean;
  /** ISO 8601 UTC. */
  createdAt: string;
  /** When the dice were rolled. Null while open, and for parties rolled before it was recorded. */
  rolledAt: string | null;
  /** When the host deleted it. Only the host sees a deleted party. */
  deletedAt: string | null;
  /** Until when the host can restore it. */
  restorableUntil: string | null;
};

/** A party as the asking person sees it. */
export type PartyJson = PartySummaryJson & {
  /** The secret phrase, for the host only. */
  password: string | null;
  /** Only for members. */
  participantCount: number | null;
  /** The host sees everyone; other members see up to three people besides themselves. */
  participants: string[] | null;
  /** Who this person gives a gift to, once the dice are rolled. */
  target: { name: string } | null;
};

const isoTime = (ms: number) => new Date(ms).toISOString();

const deletion = (deletedAt: number | null | undefined) => ({
  deletedAt: deletedAt ? isoTime(deletedAt) : null,
  restorableUntil: deletedAt ? isoTime(deletedAt + RESTORE_WINDOW_MS) : null,
});

export function toPartyJson(view: PartyView): PartyJson {
  return {
    code: view.slug,
    name: view.name,
    isHost: view.isHost,
    isProtected: view.isProtected,
    isClosed: view.isClosed,
    isJoined: view.isJoined,
    createdAt: isoTime(view.createdAt),
    rolledAt: view.closedAt === null ? null : isoTime(view.closedAt),
    ...deletion(view.deletedAt),
    password: view.password,
    participantCount: view.participantCount,
    participants: view.participants,
    target: view.target ? { name: view.target.name } : null,
  };
}

const toSummaryJson = (summary: UserPartyRecord): PartySummaryJson => ({
  code: summary.slug,
  name: summary.name,
  isHost: summary.isHost,
  isProtected: summary.isProtected,
  isClosed: summary.isClosed,
  isJoined: true,
  createdAt: isoTime(summary.createdAt),
  rolledAt: summary.closedAt === null ? null : isoTime(summary.closedAt),
  ...deletion(summary.deletedAt),
});

/** Cursors are opaque to clients: the last row's creation time and code, base64-encoded. */
export const encodeCursor = ({ createdAt, slug }: PartyListCursor) => btoa(`${createdAt}:${slug}`);

export function decodeCursor(cursor: string): PartyListCursor {
  let match: RegExpExecArray | null = null;
  try {
    match = /^(\d{1,15}):([A-Z]{5,8})$/.exec(atob(cursor));
  } catch {
    // Not base64: reported below.
  }
  if (!match) {
    throw fail('invalid', 'Invalid cursor.', 'after');
  }
  return { createdAt: Number(match[1]), slug: match[2] };
}

const isComplete = (item: UserPartyListItem): item is UserPartyListItem & UserPartyRecord =>
  item.isHost !== null && item.isProtected !== null && item.isClosed !== null;

/**
 * A page of the user's parties: one UserDO call, which also checks the session (null when it no longer belongs to the
 * user). Rows saved before summaries existed are filled in from their parties once and stored for next time; parties
 * that no longer exist are left out. Asks for one row more than `first` to tell whether there is another page.
 */
export async function listParties(env: Env, email: string, session: Session, first: number, after?: PartyListCursor) {
  const user = env.USER.getByName(email);
  const rows = await user.listParties(first + 1, after, session);
  if (!rows) {
    return null;
  }
  const hasMore = rows.length > first;
  const items = rows.slice(0, first);

  const stale = items.filter(item => !isComplete(item));
  const refreshed = new Map<string, UserPartyRecord | null>();
  if (stale.length) {
    const views = await Promise.all(stale.map(item => env.PARTY.getByName(item.slug).view(session.userId)));
    const records = views.map((view, i): UserPartyRecord | null => view && {
      slug: view.slug, name: view.name, isHost: view.isHost, isProtected: view.isProtected, isClosed: view.isClosed,
      deletedAt: view.deletedAt, createdAt: stale[i].createdAt, closedAt: view.closedAt,
    });
    stale.forEach((item, i) => refreshed.set(item.slug, records[i]));
    await user.apply(records.filter(record => record !== null).map(party => ({ type: 'addParty' as const, party })));
  }

  const parties = items
    .map(item => (isComplete(item) ? item : refreshed.get(item.slug)))
    .filter(party => party !== null && party !== undefined)
    .map(toSummaryJson);
  // The cursor comes from the last row, not the last party, so a party that was left out doesn't restart the page.
  const last = items.at(-1);
  return { items: parties, hasMore, endCursor: last ? encodeCursor(last) : null, count: items.length, refreshed: stale.length };
}
