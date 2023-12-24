import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';

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
  // return new ApolloServer({
  //   schema,
  //   playground,
  //   introspection: playground,
  //   context: context => ({
  //     ...context,
  //     ...overrideContext,
  //     db,
  //     token: null,
  //     user: null,
  //   } as IContext),
  //   engine: false, // getEngineSettings(isProduction),
  //   formatError: error => {
  //     logger.error(`${error.message}${error.extensions && error.extensions.exception && error.extensions.exception
  //       ? ['\n', ...error.extensions!.exception!.stacktrace].join('\n')
  //       : '<NO STACK TRACE>'
  //       }`);
  //     return error;
  //   },
  //   debug: !isProduction,
  // });
  const server = new ApolloServer<ApolloContext>({
    typeDefs,
    resolvers,
    includeStacktraceInErrorResponses: false,
    plugins: [
      ApolloServerPluginLandingPageLocalDefault(),
    ]
  });
  await server.start();
  return server;
};
