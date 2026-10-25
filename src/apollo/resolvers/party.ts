import { GraphQLError } from "graphql";

import { ApolloContext } from "src/apollo/context";
import { Party } from "src/apollo/types";
import { PartyListCursor, PartyView, UserPartyListItem, UserPartyRecord } from "src/do/types";
import { Env } from "src/env";
import { nodeIdToStr } from "src/utils/strings/nodeId";
import { withSpan } from "src/utils/tracing";

type PartyArgs = {
  code: string;
}

type PartiesArgs = {
  first: number;
}

type PartyHistoryArgs = {
  first: number;
  after?: string | null;
}

export const PARTY_CODE_RE = /^[QWERTYUIPASDFGHJKLZXCVBNMO]{5}$/;

const MAX_PARTIES = 100;

const clampPageSize = (first: number, min = 0) => Math.max(min, Math.min(first, MAX_PARTIES));

/** Cursors are opaque to clients: the last row's creation time and slug, base64-encoded. */
export const encodeCursor = ({ createdAt, slug }: PartyListCursor) => btoa(`${createdAt}:${slug}`);

export function decodeCursor(cursor: string): PartyListCursor {
  let match: RegExpExecArray | null = null;
  try {
    match = /^(\d+):([A-Z]+)$/.exec(atob(cursor));
  } catch {
    // Not base64: reported below.
  }
  if (!match) {
    throw new GraphQLError('Invalid cursor.', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  return { createdAt: Number(match[1]), slug: match[2] };
}

export function partyViewToNode(view: PartyView | null): Party | null {
  if (!view) {
    return null;
  }
  return {
    id: nodeIdToStr({ kind: 'Party', id: view.slug }),
    name: view.name,
    code: view.slug,
    isJoined: view.isJoined,
    isHost: view.isHost,
    password: view.password,
    isProtected: view.isProtected,
    participantCount: view.participantCount,
    participants: view.participants,
    isClosed: view.isClosed,
    target: view.target
      ? { id: nodeIdToStr({ kind: 'User', id: view.target.id }), name: view.target.name }
      : null,
  };
}

export async function viewParty(env: Env, code: string, userId?: string): Promise<PartyView | null> {
  if (!PARTY_CODE_RE.test(code)) {
    return null;
  }
  return await env.PARTY.getByName(code).view(userId);
}

/** A party in the user's list: the summary fields from UserDO. The rest load lazily (see `partyFields`). */
type PartySummaryNode = Pick<Party, 'id' | 'code' | 'name' | 'isHost' | 'isProtected' | 'isClosed' | 'isJoined'>;

const summaryToNode = (summary: UserPartyRecord): PartySummaryNode => ({
  id: nodeIdToStr({ kind: 'Party', id: summary.slug }),
  code: summary.slug,
  name: summary.name,
  isHost: summary.isHost,
  isProtected: summary.isProtected,
  isClosed: summary.isClosed,
  isJoined: true,
});

const isComplete = (item: UserPartyListItem): item is UserPartyRecord =>
  item.isHost !== null && item.isProtected !== null && item.isClosed !== null;

/** Loads a party's full view once per request, however many fields ask for it. */
export function loadPartyNode(context: ApolloContext, code: string): Promise<Party | null> {
  context.partyNodes ??= new Map();
  let node = context.partyNodes.get(code);
  if (!node) {
    node = viewParty(context.env, code, context.userId).then(partyViewToNode);
    context.partyNodes.set(code, node);
  }
  return node;
}

const lazy = <K extends 'password' | 'participantCount' | 'participants' | 'target'>(field: K) =>
  async (parent: Partial<Party> & { code: string }, args: unknown, context: ApolloContext) =>
    field in parent ? parent[field] : (await loadPartyNode(context, parent.code))?.[field] ?? null;

/** Fields of Party that a summary doesn't carry: they cost a call to the party, so only made when asked for. */
export const partyFields = {
  password: lazy('password'),
  participantCount: lazy('participantCount'),
  participants: lazy('participants'),
  target: lazy('target'),
};

/**
 * Reads a page of the signed-in user's parties: one UserDO call. Rows saved before summaries existed are filled in
 * from their parties once and stored for next time; parties that no longer exist are left out.
 * Asks for one row more than `first` to tell whether there is another page.
 */
async function listParties(context: ApolloContext, userEmail: string, first: number, after?: PartyListCursor) {
  const user = context.env.USER.getByName(userEmail);
  const rows = await user.listParties(first + 1, after);
  const hasMore = rows.length > first;
  const items = rows.slice(0, first);

  const stale = items.filter(item => !isComplete(item));
  const refreshed = new Map<string, Party | null>();
  if (stale.length) {
    const nodes = await Promise.all(stale.map(item => loadPartyNode(context, item.slug)));
    stale.forEach((item, i) => refreshed.set(item.slug, nodes[i]));
    await user.apply(nodes.filter((node): node is Party => Boolean(node)).map(node => ({
      type: 'addParty' as const,
      party: {
        slug: node.code, name: node.name, isHost: node.isHost, isProtected: node.isProtected, isClosed: node.isClosed,
        createdAt: stale.find(item => item.slug === node.code)!.createdAt,
      },
    })));
  }

  const nodes = items
    .map(item => (isComplete(item) ? summaryToNode(item) : refreshed.get(item.slug)))
    .filter(Boolean);
  // The cursor comes from the last row, not the last node, so a party that was left out doesn't restart the page.
  const last = items.at(-1);
  return { nodes, hasMore, endCursor: last ? encodeCursor(last) : null, count: items.length, refreshed: stale.length };
}

export default {
  party: async (root: any, { code }: PartyArgs, context: ApolloContext) =>
    withSpan('api.party', { 'api.action': 'party', 'user.id': context.userId, 'party.code': code.toUpperCase() }, async span => {
      const node = await loadPartyNode(context, code.toUpperCase());
      span.setAttributes({ 'party.found': Boolean(node), 'party.joined': node?.isJoined });
      return node;
    }),

  parties: async (root: any, { first }: PartiesArgs, context: ApolloContext) =>
    withSpan('api.parties', { 'api.action': 'parties', 'user.id': context.userId, 'parties.first': first }, async span => {
      const { userId, userEmail } = context;
      if (!userId || !userEmail) {
        return null;
      }
      const page = await listParties(context, userEmail, clampPageSize(first));
      span.setAttributes({ 'parties.count': page.count, 'parties.refreshed': page.refreshed });
      return page.nodes;
    }),

  partyHistory: async (root: any, { first, after }: PartyHistoryArgs, context: ApolloContext) =>
    withSpan('api.partyHistory', { 'api.action': 'partyHistory', 'user.id': context.userId, 'parties.first': first }, async span => {
      const { userId, userEmail } = context;
      if (!userId || !userEmail) {
        return null;
      }
      // At least one party per page, so a page that says there are more always carries the cursor to them.
      const page = await listParties(context, userEmail, clampPageSize(first, 1), after ? decodeCursor(after) : undefined);
      span.setAttributes({ 'parties.count': page.count, 'parties.refreshed': page.refreshed, 'parties.has_more': page.hasMore });
      return { items: page.nodes, hasMore: page.hasMore, endCursor: page.endCursor };
    }),
};
