import { Env } from 'src/env';

const encoder = new TextEncoder();

// One HMAC key per signing key and purpose, derived once per isolate.
const keys = new Map<string, Promise<CryptoKey>>();

/**
 * An HMAC key for one purpose (`info`): HKDF over JWT_PRIVATE_KEY, so no new secret has to be managed and the key
 * itself is never used for anything else.
 */
function refKey(secret: string, info: string): Promise<CryptoKey> {
  const id = `${info}:${secret}`;
  let key = keys.get(id);
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']).then(material =>
      crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(info) },
        material,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign'],
      ));
    keys.set(id, key);
  }
  return key;
}

const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

/**
 * How logs and traces refer to a party: a keyed hash of its code, the same for the same code, so a party's requests
 * can still be followed. A code is the key to a party without a secret phrase, so it never goes to the logs itself,
 * and a plain hash wouldn't do: 26^8 codes can be tried one by one against it.
 */
export async function partyRef(env: Env, code: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await refKey(env.JWT_PRIVATE_KEY, 'log-ref'), encoder.encode(code));
  return hex(new Uint8Array(signature).slice(0, 6));
}

/**
 * How the per-address email limit (`MAIL_RATE_LIMIT_ADDRESS`) names an address: a keyed hash of it, with a key of its
 * own, so the address itself never goes to Cloudflare's rate limiter, and the hash can't be tried against a list of
 * addresses without the key. `email` is the canonical address.
 */
export async function mailRef(env: Env, email: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await refKey(env.JWT_PRIVATE_KEY, 'mail-ref'), encoder.encode(email));
  return hex(new Uint8Array(signature).slice(0, 16));
}
