const toHex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

/**
 * Generates an id of 24 hex characters, starting with the creation time in seconds, so ids sort by creation time
 * (the same format as the ids of accounts and parties made before the move to Cloudflare).
 */
export function newObjectId(now: number = Date.now()): string {
  const seconds = Math.floor(now / 1000).toString(16).padStart(8, '0');
  return seconds + toHex(crypto.getRandomValues(new Uint8Array(8)));
}
