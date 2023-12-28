import { ApolloContext } from "src/apollo/context";
import { nodeIdToStr } from "src/utils/strings/nodeId";

export default {
  user: async (root: any, args: any, { retrieveUser }: ApolloContext) => {
    const user = await retrieveUser();

    if (!user) {
      return null;
    }

    return {
      id: nodeIdToStr({ kind: 'User', id: user._id }),
      name: user.name,
      joined: user.joined,
    }
  },
};
