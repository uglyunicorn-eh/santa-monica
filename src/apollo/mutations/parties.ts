import { ApolloContext, requireUser } from 'src/apollo/context';
import { PARTY_CODE_RE, partyViewToNode } from 'src/apollo/resolvers/party';
import { MutationPayload } from 'src/apollo/types';
import { PartyResult } from 'src/do/types';
import _ from 'src/utils/graphql/resolvable';
import { newObjectId } from 'src/utils/ids';
import { strToNodeId } from 'src/utils/strings/nodeId';
import { randomString } from 'src/utils/strings/random';
import { annotate } from 'src/utils/tracing';

import { CancelPartyInput, ClosePartyInput, CreatePartyInput, JoinPartyInput, LeavePartyInput } from "./types";
import { cancelPartyInputSchema, closePartyInputSchema, createPartyInputSchema, joinPartyInputSchema, leavePartyInputSchema } from "./validation";

const SLUG_ATTEMPTS = 10;

/** How many open (not closed) parties one person can host at a time. */
export const MAX_OPEN_HOSTED_PARTIES = 3;

const tooManyOpenParties = {
  status: 'error' as const,
  userErrors: [{
    fieldName: null,
    messages: [`You can host up to ${MAX_OPEN_HOSTED_PARTIES} open parties at a time. Close or cancel one of them to start a new one.`],
  }],
};

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
  // Every party mutation needs a session; the handlers below can rely on userId and userEmail.
  parties: (root: unknown, args: unknown, context: ApolloContext) => {
    requireUser(context);
    return partyMutations;
  },
};

const partyMutations = {

    createParty: _(createPartyInputSchema, 'createParty')(async (input: CreatePartyInput, { env, userEmail }: ApolloContext) => {
      annotate({ 'party.protected': Boolean(input.password) });
      // One UserDO call reads the host's display name and how many open parties they already host.
      const user = await env.USER.getByName(userEmail!).hostProfile();
      if (!user) {
        return notLoggedIn('creating');
      }
      annotate({ 'user.open_hosted_parties': user.openHostedParties });
      if (user.openHostedParties >= MAX_OPEN_HOSTED_PARTIES) {
        return tooManyOpenParties;
      }
      for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
        const slug = randomString(5, 'QWERTYUIPASDFGHJKLZXCVBNMO');
        const result = await env.PARTY.getByName(slug).create({
          id: newObjectId(),
          slug,
          name: input.name,
          password: input.password || null,
          host: { id: user.id, email: userEmail!, name: user.name },
        });
        annotate({ 'party.code_attempts': attempt + 1 });
        if ('conflict' in result) {
          continue;
        }
        annotate({ 'party.code': slug });
        return toPayload(result);
      }
      throw new Error('Unable to generate a unique party code.');
    }),

    joinParty: _(joinPartyInputSchema, 'joinParty')(async ({ party, name, password }: JoinPartyInput, { env, userId, userEmail }: ApolloContext) => {
      const slug = partySlug(party);
      if (!slug) {
        return unknownParty;
      }
      annotate({ 'party.code': slug });

      // The member comes from the session token and the name from the form: no need to read the profile.
      return toPayload(await env.PARTY.getByName(slug).join(
        { id: userId!, email: userEmail!, name },
        name,
        password || null,
      ));
    }),

    leaveParty: _(leavePartyInputSchema, 'leaveParty')(async ({ party }: LeavePartyInput, { env, userId }: ApolloContext) => {
      const slug = partySlug(party);
      if (!slug) {
        return unknownParty;
      }
      annotate({ 'party.code': slug });

      return toPayload(await env.PARTY.getByName(slug).leave(userId!));
    }),

    closeParty: _(closePartyInputSchema, 'closeParty')(async ({ party }: ClosePartyInput, { env, userId }: ApolloContext) => {
      const slug = partySlug(party);
      if (!slug) {
        return unknownParty;
      }
      annotate({ 'party.code': slug });

      return toPayload(await env.PARTY.getByName(slug).close(userId!));
    }),

    cancelParty: _(cancelPartyInputSchema, 'cancelParty')(async ({ party }: CancelPartyInput, { env, userId }: ApolloContext) => {
      const slug = partySlug(party);
      if (!slug) {
        return unknownParty;
      }
      annotate({ 'party.code': slug });

      const result = await env.PARTY.getByName(slug).cancel(userId!);
      return result.ok
        ? {}
        : { status: 'error' as const, userErrors: [{ fieldName: result.error.fieldName, messages: [result.error.message] }] };
    }),
};
