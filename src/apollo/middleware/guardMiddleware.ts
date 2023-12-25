import { GraphQLResolveInfo } from "graphql";

import { ApolloContext } from "src/apollo/context";
import { getPathFromInfo } from "src/utils/graphql";

export const guardMiddleware = async (resolve: any, root: any, args: any, context: ApolloContext,
  info: GraphQLResolveInfo) => {

  const path = getPathFromInfo(info);

  if (context.user === null) {
    if (info.operation.operation === 'mutation') {
      throw new Error('UNAUTHENTICATED');
    } else if (!/(^app$)|(^app\.)|(^party$)|(^party\.)/.exec(path)) {
      return null;
    }
  }

  return await resolve(root, args, context, info);
};
