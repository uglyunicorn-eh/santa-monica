import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';

export type ApolloContext = {

};

const typeDefs = `#graphql
  type Query {
    hello: String
  }
`;

const resolvers = {
  Query: {
    hello: () => 'world',
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
  });
  await server.start();
  return server;
};
