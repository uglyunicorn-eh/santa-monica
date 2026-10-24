import { ApolloContext } from "src/apollo/context";
import { nodeIdToStr } from "src/utils/strings/nodeId";
import { withSpan } from "src/utils/tracing";

export default {
  user: async (root: any, args: any, { retrieveUser, userId }: ApolloContext) =>
    withSpan('api.user', { 'api.action': 'user', 'user.id': userId }, async span => {
      const user = await retrieveUser();
      span.setAttribute('user.found', Boolean(user));

      if (!user) {
        return null;
      }

      return {
        id: nodeIdToStr({ kind: 'User', id: user.id }),
        name: user.name,
        joined: new Date(user.joined),
      }
    }),
};
