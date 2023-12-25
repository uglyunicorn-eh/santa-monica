import { ApolloContext } from "src/apollo/context";
import { nodeIdToStr } from "src/utils/strings/nodeId";

export default {
  user: (root: any, args: any, { user }: ApolloContext) => (user && {
    id: nodeIdToStr({ kind: 'User', id: user._id }),
    name: user.name,
  }),
};
