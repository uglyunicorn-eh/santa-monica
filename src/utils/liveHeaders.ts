// The headers the Worker sets on a live-updates WebSocket upgrade it passes to a Durable Object (src/api/live.ts).
// Kept apart, with no imports, so the Durable Objects can read them without importing the API's routes.

/** The user a WebSocket upgrade is for, set by the Worker on the request it passes to a Durable Object. */
export const LIVE_USER_HEADER = 'x-live-user';

/** The token version the ticket was issued at, when it has one (the user's own updates refuse a stale one). */
export const LIVE_VERSION_HEADER = 'x-live-version';
