import { Hono } from 'hono';

import { action } from 'src/api/action';
import { ApiEnv, clientIp } from 'src/api/context';
import { fail } from 'src/api/errors';
import { send } from 'src/api/input';
import { checkUpgrade, passUpgrade } from 'src/api/live';
import { stats as statsJson } from 'src/api/schemas';
import { cacheTtl } from 'src/api/viewCache';
import { STATS_NAME } from 'src/do/StatsDO';

/**
 * The Party'o'meter (src/do/StatsDO.ts). Public: the number isn't private, so there's no session or ticket. The count
 * is kept in the isolate's memory for a few seconds, so most page loads never reach the object.
 */
export const stats = new Hono<ApiEnv>();

let kept: { rolled: number; until: number } | undefined;

/** Forgets the kept count. Used by tests. */
export const forgetStats = () => {
  kept = undefined;
};

/** How many parties have rolled: `{rolled}`. For the first paint, and when the WebSocket can't connect. */
stats.get('/', action('stats', async c => {
  const now = Date.now();
  if (!kept || kept.until <= now) {
    kept = { rolled: await c.env.STATS.getByName(STATS_NAME).count(), until: now + cacheTtl(c.env) };
  }
  c.header('Cache-Control', 'public, max-age=10');
  return send(c, statsJson, { rolled: kept.rolled });
}));

/**
 * The count as it changes: a WebSocket that gets `{"type":"stats","rolled":N}` on connect and after every roll.
 * Only the app's pages may open it, and only a few times a minute per client.
 */
stats.get('/live', action('watchStats', async c => {
  checkUpgrade(c);
  const { success } = await c.env.STATS_WATCH_RATE_LIMIT_IP.limit({ key: clientIp(c) });
  if (!success) {
    throw fail('rate_limited', 'Too many connections. Please wait a minute and try again.');
  }
  const answer = await c.env.STATS.getByName(STATS_NAME).fetch(c.req.raw);
  return passUpgrade(answer, () => fail('unavailable', "The Party'o'meter isn't available right now. Please try again in a minute."));
}));
