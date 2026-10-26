import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { ApiEnv } from 'src/api/context';
import { fail } from 'src/api/errors';
import { MAX_BODY_BYTES } from 'src/api/limits';
import { live } from 'src/api/live';
import { auth } from 'src/api/routes/auth';
import { me } from 'src/api/routes/me';
import { parties } from 'src/api/routes/parties';

/** The API, served under /v1. JSON in, JSON out; every failure answers `{ error: { code, message, field } }`. */
export const api = new Hono<ApiEnv>({ strict: false });

// Every input field has its own limit too (src/api/limits.ts); this caps the request as a whole before it is read.
api.use(bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: c => c.json(fail('invalid', 'The request is too large.').toBody(), 413),
}));

api.route('/auth', auth);
api.route('/me', me);
api.route('/parties', parties);
api.route('/live', live);

/** Every route the API serves, as "METHOD /path". Tests check each has a call budget and a revocation check. */
export const routeList = () => api.routes
  .filter(r => r.method !== 'ALL')
  .map(r => `${r.method} ${r.path}`)
  .filter((route, i, all) => all.indexOf(route) === i);
