import { ApolloContext, requireUser } from 'src/apollo/context';
import { userToNode } from 'src/apollo/resolvers/user';
import _ from 'src/utils/graphql/resolvable';

import { UpdateNameInput } from './types';
import { updateNameInputSchema } from './validation';

const sessionExpired = {
  status: 'error' as const,
  userErrors: [{
    fieldName: null,
    messages: ['Your session has expired. Please sign in again.'],
  }],
};

export default {
  // Every profile mutation needs a session; the handlers below can rely on userId and userEmail.
  profile: (root: unknown, args: unknown, context: ApolloContext) => {
    requireUser(context);
    return profileMutations;
  },
};

const profileMutations = {

  /**
   * Sets the profile name: the default name for parties the user joins from now on. Parties already joined keep the
   * name the user joined them with. One UserDO call, which also checks the session is still valid.
   */
  updateName: _(updateNameInputSchema, 'updateName')(async ({ name }: UpdateNameInput, { env, userId, userEmail, tokenVersion }: ApolloContext) => {
    const user = await env.USER.getByName(userEmail!).updateName(name, { userId: userId!, tokenVersion });
    return user ? { status: 'ok' as const, user: userToNode(user) } : sessionExpired;
  }),
};
