import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { applyMiddleware } from 'graphql-middleware';

import { ApolloContext } from './context';
import { authMiddleware, guardMiddleware } from './middleware';
import resolvers from './resolvers';
import mutations from './mutations';
import { typeDefs } from './typeDefs';

export const createServer = async () => {
  const schemaDef = makeExecutableSchema({
    typeDefs,
    resolvers: {
      ...resolvers,
      ...mutations,
    }
  });

  const schema = applyMiddleware(
    schemaDef,
    authMiddleware,
    guardMiddleware,
  );

  const server = new ApolloServer<ApolloContext>({
    schema,
    includeStacktraceInErrorResponses: false,
    plugins: [
      ApolloServerPluginLandingPageDisabled(),
    ],
    introspection: true,
  });
  await server.start();
  return server;
};
