import { GraphQLResolveInfo } from 'graphql';

import { ApolloContext } from 'src/apollo/context';
import { UserToken } from 'src/apollo/types';
import { strToNodeId } from 'src/utils/strings/nodeId';

const authenticate = async (context: ApolloContext) => {
  const { authToken, jwtVerify, env } = context;
  if (!authToken) {
    return;
  }
  try {
    const { sub, email } = await jwtVerify<UserToken>(authToken, 'UserToken');
    const nodeId = strToNodeId(sub);
    if (nodeId.kind !== 'User' || !email) {
      throw new Error('Invalid user token.');
    }

    context.userId = nodeId.id;
    context.userEmail = email;

    context.retrieveUser = async () => await env.USER.getByName(email).get();
  }
  catch {
    context.userId = undefined;
    context.userEmail = undefined;
    context.authToken = undefined;
  }
};

export const authMiddleware = async (resolve: any, root: any, args: any, context: ApolloContext, info: GraphQLResolveInfo) => {
  // graphql-middleware runs this for every field (sibling fields concurrently), so the token is verified once per request.
  context.auth ??= authenticate(context);
  await context.auth;

  return await resolve(root, args, context, info);
};
