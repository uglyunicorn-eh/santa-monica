import { GraphQLResolveInfo } from 'graphql';

import { ApolloContext } from 'src/apollo/context';
import { UserToken } from 'src/apollo/types';
import { UserEntity } from 'src/models';
import { strToNodeId } from 'src/utils/strings/nodeId';

export const authMiddleware = async (resolve: any, root: any, args: any, context: ApolloContext, info: GraphQLResolveInfo) => {
  const { db, authToken, jwtVerify } = context;

  if (authToken) {
    try {
      const { sub } = await jwtVerify<UserToken>(authToken);

      context.userId = strToNodeId(sub).id;

      context.retrieveUser = async () => {
        const User = db.collection('User');
        return await User.findOne({ _id: context.userId }) as UserEntity || undefined;
      }
    }
    catch {
      context.userId = undefined;
      context.authToken = undefined;
    }
  }

  return await resolve(root, args, context, info);
};
