import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';

import { api } from 'src/api';
import { ApiEnv } from 'src/api/context';
import { ApiError, fail } from 'src/api/errors';

import { homepage, name, version } from 'package.json';

export { PartyDO } from 'src/do/PartyDO';
export { UserDO } from 'src/do/UserDO';

export const app = new Hono<ApiEnv>({ strict: false });

app.use(secureHeaders({ removePoweredBy: false }));
app.use(cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  // Browsers only send these after a preflight that lists them.
  allowHeaders: ['authorization', 'content-type', 'idempotency-key'],
  maxAge: 86400,
}));

app.use(async (c, next) => {
  await next();
  c.res.headers.set('X-Developed-By', 'Made with love in Canada by Ugly Unicorn (https://uglyunicorn.ca)');
  c.res.headers.set('X-Powered-By', 'Maple syrup and magic, eh!');
});

app.get('/', c => c.json({ status: 'ok', name, version, github: homepage }));

app.route('/v1', api);

app.notFound(c => c.json(fail('not_found', 'Not found.').toBody(), 404));

// Unexpected errors are logged with an id that is also returned to the client, so a reported error can be found in
// the logs (Workers Logs and Better Stack). Nothing else about them leaves the Worker.
app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json(err.toBody(), err.status);
  }
  const errorId = crypto.randomUUID();
  console.error({ message: 'Unhandled error', errorId, path: c.req.path, error: String(err), stack: err.stack });
  return c.json({ error: { code: 'internal', message: 'Ugly Unicorn just puked a little bit :(', errorId } }, 500);
});

export default { fetch: app.fetch } satisfies ExportedHandler<ApiEnv['Bindings']>;
