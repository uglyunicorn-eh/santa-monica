import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';

import { author, name, version } from 'package.json';

import { typeDefs } from './typeDefs';

export type ApolloContext = {

};

const resolvers = {
  Query: {
    app: () => ({
      name,
      author,
      version,
    }),
    user: () => null,
  },
};

export const createServer = async (context: Partial<ApolloContext> = {}) => {
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
