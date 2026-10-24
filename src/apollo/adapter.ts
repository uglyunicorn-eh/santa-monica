import { ApolloServer, HeaderMap } from '@apollo/server';
import { Context } from 'hono';

import { Env } from 'src/env';

import { ApolloContext, makeContext } from './context';
import { createServer } from './index';

let server: Promise<ApolloServer<ApolloContext>> | undefined;

/** Serves Apollo Server from a Hono route. Apollo is started once per isolate. */
export const graphqlHandler = async (c: Context<{ Bindings: Env }>) => {
  let body: unknown;
  if (c.req.method === 'POST') {
    try {
      body = await c.req.json();
    } catch {
      return c.json({ status: 'error', error: 'Invalid JSON body' }, 400);
    }
  }

  // A failed start is not cached, so the next request tries again.
  server ??= createServer().catch(error => {
    server = undefined;
    throw error;
  });
  const res = await (await server).executeHTTPGraphQLRequest({
    httpGraphQLRequest: {
      method: c.req.method.toUpperCase(),
      headers: new HeaderMap(Object.entries(c.req.header()).map(([k, v]) => [k.toLowerCase(), v])),
      search: new URL(c.req.url).search,
      body,
    },
    context: () => makeContext(c),
  });

  // Apollo returns a chunked body only for incremental delivery (@defer / @stream), which needs graphql 17
  // and is not enabled here, so this branch can't be reached.
  /* istanbul ignore if -- @preserve */
  if (res.body.kind !== 'complete') {
    return c.json({ status: 'error', error: 'Unsupported response' }, 500);
  }
  return new Response(res.body.string, {
    status: res.status ?? 200,
    headers: Object.fromEntries(res.headers),
  });
};
