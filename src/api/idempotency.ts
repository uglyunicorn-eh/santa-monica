import { ApiContext } from 'src/api/context';
import { fail } from 'src/api/errors';
import { IDEMPOTENCY_KEY_RE } from 'src/api/limits';

/**
 * The request's `Idempotency-Key`, if it sent one. Repeating a request with the same key (for ten minutes) gives the
 * same result without doing the work again. A malformed key is refused rather than ignored, so a client never
 * believes a request is protected when it isn't.
 */
export function idempotencyKey(c: ApiContext): string | undefined {
  const key = c.req.header('idempotency-key');
  if (key === undefined) {
    return undefined;
  }
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    throw fail('invalid', 'Idempotency-Key must be 16 to 100 letters, digits, dashes or underscores.', 'Idempotency-Key');
  }
  return key;
}

/** Links remember the key they were first used with as a hash, so a stored key can't be replayed from storage. */
export async function keyHash(key: string | undefined): Promise<string | undefined> {
  if (!key) {
    return undefined;
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
