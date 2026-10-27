import { DurableObject } from 'cloudflare:workers';

import { Env } from 'src/env';

/**
 * Parties rolled before the counter existed: counted in production on 2026-10-26 (29 drawn parties). The counter
 * starts from here the first time it's used. Recount right before the first deploy (`node scripts/data.ts count`);
 * after that, a correction is one `UPDATE stats SET rolled = …` through Data Studio.
 */
export const ROLLED_BEFORE_COUNTER = 29;

/** The one StatsDO, `env.STATS.getByName(STATS_NAME)`. */
export const STATS_NAME = 'global';

/** What viewers get when the count changes, and when they connect. */
export type StatsMessage = { type: 'stats'; rolled: number };

/**
 * The Party'o'meter: how many parties have rolled their dice, ever. One row, one instance. `PartyDO` calls `rolled()`
 * once per party, when it's first drawn; viewers watch over a WebSocket with the hibernation API (`ping` is answered
 * without waking the object), so an idle viewer costs nothing. Nothing here sets a timer: one would keep the object
 * awake, and billed.
 *
 * At a few thousand viewers at once, move the sockets to several relay objects that this one pushes to; viewers only
 * know the URL, so they wouldn't notice.
 */
export class StatsDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS stats (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          rolled INTEGER NOT NULL
        )
      `);
      this.sql.exec('INSERT OR IGNORE INTO stats (id, rolled) VALUES (1, ?)', ROLLED_BEFORE_COUNTER);
    });
  }

  /** How many parties have rolled. */
  count(): number {
    return this.sql.exec<{ rolled: number }>('SELECT rolled FROM stats WHERE id = 1').one().rolled;
  }

  /** Counts a party that just rolled, and tells every viewer. Returns the new count. */
  rolled(): number {
    const rolled = this.sql.exec<{ rolled: number }>('UPDATE stats SET rolled = rolled + 1 WHERE id = 1 RETURNING rolled').one().rolled;
    const message = JSON.stringify({ type: 'stats', rolled } satisfies StatsMessage);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // Closing already; it's gone from the list next time.
      }
    }
    return rolled;
  }

  /** A viewer's WebSocket upgrade, already checked by the Worker (`GET /v1/stats/live`). Gets the count right away. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response(null, { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: 'stats', rolled: this.count() } satisfies StatsMessage));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Viewers only listen (their keep-alive "ping" never reaches here): anything else they send is ignored. */
  async webSocketMessage() {}
}
