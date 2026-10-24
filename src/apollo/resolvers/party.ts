import { ApolloContext } from "src/apollo/context";
import { Party } from "src/apollo/types";
import { PartyView } from "src/do/types";
import { Env } from "src/env";
import { nodeIdToStr } from "src/utils/strings/nodeId";

type PartyArgs = {
  code: string;
}

type PartiesArgs = {
  first: number;
}

export const PARTY_CODE_RE = /^[QWERTYUIPASDFGHJKLZXCVBNMO]{5}$/;

const MAX_PARTIES = 100;

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

export default {
  party: async (root: any, { code }: PartyArgs, { env, userId }: ApolloContext) => {
    return partyViewToNode(await viewParty(env, code.toUpperCase(), userId));
  },

  parties: async (root: any, { first }: PartiesArgs, { env, userId, userEmail }: ApolloContext) => {
    if (!userId || !userEmail) {
      return [];
    }
    const userParties = await env.USER.getByName(userEmail).listParties(Math.max(0, Math.min(first, MAX_PARTIES)));
    const views = await Promise.all(userParties.map(({ slug }) => viewParty(env, slug, userId)));
    return views.map(partyViewToNode).filter(Boolean);
  },
};
