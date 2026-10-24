import * as Sentry from '@sentry/cloudflare';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';

import { importHandler } from 'src/admin';
import { graphqlHandler } from 'src/apollo/adapter';
import { Env } from 'src/env';

import { author, name, version } from 'package.json';

export { PartyDO } from 'src/do/PartyDO';
export { UserDO } from 'src/do/UserDO';

// Not strict: the frontend calls /graph/ and Express treated /graph and /graph/ as the same route.
export const app = new Hono<{ Bindings: Env }>({ strict: false });

app.use(secureHeaders({ removePoweredBy: false }));
app.use(cors());

app.use(async (c, next) => {
  await next();
  c.res.headers.set('X-Developed-By', 'Made with love in Canada by Ugly Unicorn (https://uglyunicorn.ca)');
  c.res.headers.set('X-Powered-By', 'Maple syrup and magic, eh!');
});

app.get('/', c => c.json({ status: 'ok', name, version, author }));

app.all('/graph', graphqlHandler);

app.post('/admin/import', importHandler);

app.onError((err, c) => {
  const errorId = Sentry.captureException(err);
  console.error(err);
  return c.json({ status: 'error', error: 'Ugly Unicorn just puked a little bit :(', errorId }, 500);
});

export default Sentry.withSentry(
  (env: Env) => env.SENTRY_DSN
    ? { dsn: env.SENTRY_DSN, release: `${name}@${version}`, tracesSampleRate: 1.0 }
    : undefined,
  { fetch: app.fetch } satisfies ExportedHandler<Env>,
);
