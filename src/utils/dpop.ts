import * as jose from 'jose';

/**
 * Token binding (DPoP, RFC 9449). At sign-in the browser makes a key pair it can't export, and sends the public key;
 * the session token then carries the key's thumbprint (`cnf.jkt`). Every request with that token must come with a
 * proof (`DPoP` header) signed by the key, for that method, URL and token, made within the last minute. So a token
 * copied out of a HAR file, a log or a header is useless on its own.
 */

/** A proof's `iat` may be this far from the Worker's clock, in seconds, either way. */
export const PROOF_MAX_SKEW_S = 60;

/** Longest proof read. Ours are about 500 characters (the key is in the header). */
export const MAX_PROOF_LENGTH = 4096;

/** Longest proof id (`jti`) accepted. The app sends a UUID. */
export const MAX_JTI_LENGTH = 64;

/** The public key a browser sends at sign-in: a P-256 JWK with just its key fields. */
export type PublicJwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string };

/** Whether a proof holds, and if not, why. `skewed` means it would hold with a correct clock. */
export type ProofCheck = 'ok' | 'missing' | 'invalid' | 'skewed';

/** The `jkt` for a public key (RFC 7638 thumbprint), as bound tokens carry it in `cnf`. */
export const thumbprint = (jwk: PublicJwk) => jose.calculateJwkThumbprint(jwk, 'sha256');

/**
 * The URL a proof's `htu` names, compared without query, fragment or trailing slash (the API answers `/v1/me` and
 * `/v1/me/` alike). Undefined when it isn't a URL.
 */
export function proofUrl(url: string): string | undefined {
  try {
    const { origin, pathname } = new URL(url);
    return origin + (pathname.replace(/\/+$/, '') || '/');
  } catch {
    return undefined;
  }
}

const tokenHash = async (token: string) =>
  jose.base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));

/**
 * Checks a DPoP proof for a request made with `token`, bound to `jkt`. `now` is in seconds. This doesn't tell whether
 * the proof was used before: the user's object does that (`UserDO.holds`), with what `proofId` reads from a proof that
 * holds.
 */
export async function checkProof(
  proof: string | undefined,
  request: { method: string; url: string; token: string; jkt: string },
  now = Math.floor(Date.now() / 1000),
): Promise<ProofCheck> {
  if (!proof) {
    return 'missing';
  }
  if (proof.length > MAX_PROOF_LENGTH) {
    return 'invalid';
  }
  let payload: jose.JWTPayload;
  let jwk: jose.JWK | undefined;
  try {
    ({ payload, protectedHeader: { jwk } } = await jose.jwtVerify(proof, jose.EmbeddedJWK, {
      typ: 'dpop+jwt', algorithms: ['ES256'], currentDate: new Date(now * 1000),
    }));
  } catch {
    return 'invalid';
  }
  const holds = jwk
    && await jose.calculateJwkThumbprint(jwk, 'sha256') === request.jkt
    && typeof payload.jti === 'string' && payload.jti.length > 0 && payload.jti.length <= MAX_JTI_LENGTH
    && payload.htm === request.method
    && typeof payload.htu === 'string' && proofUrl(payload.htu) === proofUrl(request.url)
    && payload.ath === await tokenHash(request.token)
    && typeof payload.iat === 'number';
  if (!holds) {
    return 'invalid';
  }
  return Math.abs(now - payload.iat!) > PROOF_MAX_SKEW_S ? 'skewed' : 'ok';
}

/**
 * A proof's id, and until when (ms) it could be sent again, for a proof `checkProof` found to hold. Its `iat` may be
 * up to PROOF_MAX_SKEW_S in the future, so that is when it stops being accepted.
 */
export function proofId(proof: string): { jti: string; until: number } {
  const { jti, iat } = jose.decodeJwt(proof);
  return { jti: jti!, until: (iat! + PROOF_MAX_SKEW_S) * 1000 };
}
