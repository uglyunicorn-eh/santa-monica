import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';

import { ApolloContext } from './context';
import { typeDefs } from './typeDefs';
import resolvers from './resolvers';

export const createServer = async () => {
  const server = new ApolloServer<ApolloContext>({
    typeDefs,
    resolvers,
    includeStacktraceInErrorResponses: false,
    plugins: [
      ApolloServerPluginLandingPageDisabled(),
    ],
    introspection: true,
  });
  await server.start();
  return server;
};
