import { ApolloContext } from "src/apollo/context";
import { Party } from "src/apollo/types";
import { RESTORE_WINDOW_MS } from "src/do/PartyDO";
import { PartyView, UserPartyListItem, UserPartyRecord } from "src/do/types";
import { Env } from "src/env";
import { nodeIdToStr } from "src/utils/strings/nodeId";
import { withSpan } from "src/utils/tracing";

type PartyArgs = {
  code: string;
}

type PartiesArgs = {
  first: number;
}

export const PARTY_CODE_RE = /^[QWERTYUIPASDFGHJKLZXCVBNMO]{5}$/;

const MAX_PARTIES = 100;

/** When a deleted party was deleted and until when it can be restored, as ISO strings (both null otherwise). */
const deletion = (deletedAt: number | null | undefined) => ({
  deletedAt: deletedAt ? new Date(deletedAt).toISOString() : null,
  restorableUntil: deletedAt ? new Date(deletedAt + RESTORE_WINDOW_MS).toISOString() : null,
});

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
    ...deletion(view.deletedAt),
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
type PartySummaryNode = Pick<Party, 'id' | 'code' | 'name' | 'isHost' | 'isProtected' | 'isClosed' | 'isJoined' | 'deletedAt' | 'restorableUntil'>;

const summaryToNode = (summary: UserPartyRecord): PartySummaryNode => ({
  id: nodeIdToStr({ kind: 'Party', id: summary.slug }),
  code: summary.slug,
  name: summary.name,
  isHost: summary.isHost,
  isProtected: summary.isProtected,
  isClosed: summary.isClosed,
  ...deletion(summary.deletedAt),
  isJoined: true,
});

const isComplete = (item: UserPartyListItem): item is UserPartyListItem & UserPartyRecord =>
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

export default {
  party: async (root: any, { code }: PartyArgs, context: ApolloContext) =>
    withSpan('api.party', { 'api.action': 'party', 'user.id': context.userId, 'party.code': code.toUpperCase() }, async span => {
      const node = await loadPartyNode(context, code.toUpperCase());
      span.setAttributes({ 'party.found': Boolean(node), 'party.joined': node?.isJoined });
      return node;
    }),

  parties: async (root: any, { first }: PartiesArgs, context: ApolloContext) =>
    withSpan('api.parties', { 'api.action': 'parties', 'user.id': context.userId, 'parties.first': first }, async span => {
      const { env, userId, userEmail } = context;
      if (!userId || !userEmail) {
        return null;
      }
      const user = env.USER.getByName(userEmail);
      const items = await user.listParties(Math.max(0, Math.min(first, MAX_PARTIES)));

      // Rows saved before summaries existed: fill them in from their parties once, and store them for next time.
      const stale = items.filter(item => !isComplete(item));
      const refreshed = new Map<string, Party | null>();
      if (stale.length) {
        const nodes = await Promise.all(stale.map(item => loadPartyNode(context, item.slug)));
        stale.forEach((item, i) => refreshed.set(item.slug, nodes[i]));
        await user.apply(nodes.filter((node): node is Party => Boolean(node)).map(node => ({
          type: 'addParty' as const,
          party: {
            slug: node.code, name: node.name, isHost: node.isHost, isProtected: node.isProtected, isClosed: node.isClosed,
            deletedAt: node.deletedAt ? Date.parse(node.deletedAt) : null,
            createdAt: stale.find(item => item.slug === node.code)!.createdAt,
          },
        })));
      }

      span.setAttributes({ 'parties.count': items.length, 'parties.refreshed': stale.length });
      return items
        .map(item => (isComplete(item) ? summaryToNode(item) : refreshed.get(item.slug)))
        .filter(Boolean);
    }),
};
