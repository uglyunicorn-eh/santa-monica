import { Env } from 'src/env';

const encoder = new TextEncoder();

// One HMAC key per signing key, derived once per isolate.
const keys = new Map<string, Promise<CryptoKey>>();

/**
 * The log key: HKDF over JWT_PRIVATE_KEY with its own `info`, so no new secret has to be managed and the signing key
 * itself is never used for anything else.
 */
function logKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']).then(material =>
      crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode('log-ref') },
        material,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign'],
      ));
    keys.set(secret, key);
  }
  return key;
}

/**
 * How logs and traces refer to a party: a keyed hash of its code, the same for the same code, so a party's requests
 * can still be followed. A code is the key to a party without a secret phrase, so it never goes to the logs itself,
 * and a plain hash wouldn't do: 26^8 codes can be tried one by one against it.
 */
export async function partyRef(env: Env, code: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await logKey(env.JWT_PRIVATE_KEY), encoder.encode(code));
  return [...new Uint8Array(signature).slice(0, 6)].map(b => b.toString(16).padStart(2, '0')).join('');
}
