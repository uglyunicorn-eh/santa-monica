import { ApolloContext } from 'src/apollo/context';
import { PARTY_CODE_RE, partyViewToNode } from 'src/apollo/resolvers/party';
import { MutationPayload } from 'src/apollo/types';
import { PartyResult } from 'src/do/types';
import _ from 'src/utils/graphql/resolvable';
import { newObjectId } from 'src/utils/ids';
import { strToNodeId } from 'src/utils/strings/nodeId';
import { randomString } from 'src/utils/strings/random';

import { ClosePartyInput, CreatePartyInput, JoinPartyInput, LeavePartyInput } from "./types";
import { closePartyInputSchema, createPartyInputSchema, joinPartyInputSchema, leavePartyInputSchema } from "./validation";

const SLUG_ATTEMPTS = 10;

const notLoggedIn = (action: string) => ({
  status: 'error',
  userErrors: [{
    fieldName: null,
    messages: [`You must be logged in before ${action} the party.`],
  }],
} as MutationPayload);

const unknownParty = {
  status: 'error' as const,
  userErrors: [{
    fieldName: 'party',
    messages: ['Unknown input type. Must be Party.'],
  }],
};

/** Returns the party slug from a Party node id, or null when the id is not a Party. */
const partySlug = (party: string): string | null => {
  try {
    const { kind, id } = strToNodeId(party);
    return kind === 'Party' && PARTY_CODE_RE.test(id) ? id : null;
  } catch {
    return null;
  }
};

const toPayload = (result: PartyResult) => result.ok
  ? { node: partyViewToNode(result.view) }
  : {
    status: 'error' as const,
    userErrors: [{ fieldName: result.error.fieldName, messages: [result.error.message] }],
  };

export default {
  parties: () => ({

    createParty: _(createPartyInputSchema)(async (input: CreatePartyInput, { env, userEmail, retrieveUser }: ApolloContext) => {
      const user = await retrieveUser();
      if (!user) {
        return notLoggedIn('creating');
      }
      for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
        const slug = randomString(5, 'QWERTYUIPASDFGHJKLZXCVBNMO');
        const result = await env.PARTY.getByName(slug).create({
          id: newObjectId(),
          slug,
          name: input.name,
          password: input.password || null,
          host: { id: user.id, email: userEmail ?? user.email, name: user.name },
        });
        if ('conflict' in result) {
          continue;
        }
        return toPayload(result);
      }
      throw new Error('Unable to generate a unique party code.');
    }),

    joinParty: _(joinPartyInputSchema)(async ({ party, name, password }: JoinPartyInput, context: ApolloContext) => {
      const { env, userId, retrieveUser } = context;

      if (!userId) {
        return notLoggedIn('joining');
      }

      const slug = partySlug(party);
      if (!slug) {
        return unknownParty;
      }

      const user = await retrieveUser();
      if (!user) {
        return notLoggedIn('joining');
      }

      return toPayload(await env.PARTY.getByName(slug).join(
        { id: user.id, email: user.email, name: user.name },
        name,
        password || null,
      ));
    }),

    leaveParty: _(leavePartyInputSchema)(async ({ party }: LeavePartyInput, { env, userId }: ApolloContext) => {
      if (!userId) {
        return notLoggedIn('leaving');
      }

      const slug = partySlug(party);
      if (!slug) {
        return unknownParty;
      }

      return toPayload(await env.PARTY.getByName(slug).leave(userId));
    }),

    closeParty: _(closePartyInputSchema)(async ({ party }: ClosePartyInput, { env, userId }: ApolloContext) => {
      if (!userId) {
        return notLoggedIn('closing');
      }

      const slug = partySlug(party);
      if (!slug) {
        return unknownParty;
      }

      return toPayload(await env.PARTY.getByName(slug).close(userId));
    }),
  }),
};
