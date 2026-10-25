import { encodeCursor } from 'src/api/schemas';
import { PartyListCursor, UserPartyListItem, UserPartyRecord } from 'src/do/types';
import { Env } from 'src/env';
import { Session } from 'src/utils/session';

const isComplete = (item: UserPartyListItem): item is UserPartyListItem & UserPartyRecord =>
  item.isHost !== null && item.isProtected !== null && item.isClosed !== null;

/**
 * A page of the user's parties, as stored summaries: one UserDO call, which also checks the session (null when it no
 * longer belongs to the user). Rows saved before summaries existed are filled in from their parties once and stored
 * for next time; parties that no longer exist are left out. Asks for one row more than `first` to tell whether there
 * is another page.
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
    .filter((party): party is UserPartyRecord => party !== null && party !== undefined);
  // The cursor comes from the last row, not the last party, so a party that was left out doesn't restart the page.
  const last = items.at(-1);
  return { items: parties, hasMore, endCursor: last ? encodeCursor(last) : null, count: items.length, refreshed: stale.length };
}
