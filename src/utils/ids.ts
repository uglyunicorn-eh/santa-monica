const toHex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

/**
 * Generates an ObjectId-compatible id: 24 hex characters, starting with the creation time in seconds,
 * so new ids sort by creation time like the ones imported from Mongo.
 */
export function newObjectId(now: number = Date.now()): string {
  const seconds = Math.floor(now / 1000).toString(16).padStart(8, '0');
  return seconds + toHex(crypto.getRandomValues(new Uint8Array(8)));
}

export function isObjectId(s: string): boolean {
  return /^[0-9a-f]{24}$/.test(s);
}

export function objectIdTime(id: string): number {
  return parseInt(id.slice(0, 8), 16) * 1000;
}
