import { Env } from 'src/env';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Additional data for every sealed email, so a sealed value can't pass for anything else. */
const AAD = encoder.encode('token-email');
const IV_BYTES = 12;

// One AES key per signing key, derived once per isolate.
const keys = new Map<string, Promise<CryptoKey>>();

/**
 * The key that seals the email in session tokens and live tickets: HKDF over JWT_PRIVATE_KEY with its own `info`, like
 * the log ref key (src/utils/logRef.ts). No new secret, and rotating the signing key, which already ends every
 * session, also retires every sealed email, which is exactly when they should stop working.
 */
function sealKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']).then(material =>
      crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode('token-email') },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      ));
    keys.set(secret, key);
  }
  return key;
}

const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

/**
 * The email, sealed for a token's `em` claim: AES-256-GCM with a random IV, base64url. Only the Worker can open it,
 * so a token that leaks (a HAR file, a log, a copied header) no longer shows whose it is.
 */
export async function sealEmail(env: Env, email: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, await sealKey(env.JWT_PRIVATE_KEY), encoder.encode(email));
  const out = new Uint8Array(IV_BYTES + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), IV_BYTES);
  return toBase64Url(out);
}

/** Opens an `em` claim. Undefined when it isn't one of ours (malformed, tampered with, or sealed with another key). */
export async function openEmail(env: Env, sealed: string): Promise<string | undefined> {
  try {
    const bytes = fromBase64Url(sealed);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES), additionalData: AAD }, await sealKey(env.JWT_PRIVATE_KEY), bytes.slice(IV_BYTES),
    );
    return decoder.decode(plain);
  } catch {
    return undefined;
  }
}

/** Whether new tokens carry the sealed `em` instead of a readable `email` (`SEAL_TOKEN_EMAIL`, see wrangler.jsonc). */
export const sealsTokenEmail = (env: Env) => env.SEAL_TOKEN_EMAIL === 'true';

/** The email claim for a new session token or live ticket: `{ em }` once sealing is on, `{ email }` until then. */
export async function emailClaim(env: Env, email: string): Promise<{ email: string } | { em: string }> {
  return sealsTokenEmail(env) ? { em: await sealEmail(env, email) } : { email };
}

/** The email a token names, from `em` (opened) or `email`. Undefined when it names none, or `em` doesn't open. */
export async function tokenEmail(env: Env, claims: { email?: string; em?: string }): Promise<string | undefined> {
  return claims.em !== undefined ? await openEmail(env, claims.em) : claims.email;
}
