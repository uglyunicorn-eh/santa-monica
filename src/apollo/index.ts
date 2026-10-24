import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { makeExecutableSchema } from '@graphql-tools/schema';

import { ApolloContext } from './context';
import resolvers from './resolvers';
import mutations from './mutations';
import { typeDefs } from './typeDefs';

export const createServer = async () => {
  // Auth is checked once per request in makeContext; root fields that need a session check it themselves.
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers: {
      ...resolvers,
      ...mutations,
    }
  });

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
