import { ApolloContext } from "src/apollo/context";
import { User } from "src/apollo/types";
import { UserRecord } from "src/do/types";
import { nodeIdToStr } from "src/utils/strings/nodeId";
import { withSpan } from "src/utils/tracing";

/** The signed-in user as a User node, email included. */
export const userToNode = (user: UserRecord): User & { joined: Date } => ({
  id: nodeIdToStr({ kind: 'User', id: user.id }),
  name: user.name,
  email: user.email,
  joined: new Date(user.joined),
});

export default {
  user: async (root: any, args: any, { retrieveUser, userId }: ApolloContext) =>
    withSpan('api.user', { 'api.action': 'user', 'user.id': userId }, async span => {
      const user = await retrieveUser();
      span.setAttribute('user.found', Boolean(user));
      return user ? userToNode(user) : null;
    }),
};
