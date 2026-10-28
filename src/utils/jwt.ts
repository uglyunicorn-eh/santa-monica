import * as jose from 'jose';

export type IssuedAt = {
  iat: number,
};

export type ExpiredAt = {
  exp: number,
};

export type TokenPayload = Partial<IssuedAt & ExpiredAt> & Record<string, unknown>;
export type TokenValue = string;

export type IssueTokenOptions = {
  ttl?: number;
};

export type VerifyTokenOptions = {
  /** Also accept a token that expired at most this many seconds ago (to send a fresh sign-in link for an old one). */
  expiredFor?: number;
};

export type TokenType = 'EnterRequest' | 'UserToken' | 'AccountDeletion' | 'EmailChange' | 'EmailChangeCancel' | 'LiveTicket';

export type JwtHelpers = {
  issueToken: <P extends TokenPayload = TokenPayload>(type: TokenType, payload: P, options?: IssueTokenOptions) => Promise<TokenValue>;
  jwtVerify: <P extends TokenPayload = TokenPayload>(token: string, type: TokenType, options?: VerifyTokenOptions) => Promise<P>;
};

const encoder = new TextEncoder();

// One key per secret, derived once per isolate.
const keys = new Map<string, Promise<Uint8Array>>();

/**
 * The 256-bit key every token is encrypted with: HKDF over JWT_PRIVATE_KEY with its own `info`, like the log ref key
 * (src/utils/logRef.ts). No other secret, and rotating JWT_PRIVATE_KEY retires every token at once.
 */
function tokenKey(secret: string): Promise<Uint8Array> {
  let key = keys.get(secret);
  if (!key) {
    // The same key whether the PEM is stored with real or escaped ("\n") line breaks.
    const material = secret.replace(/\\n/g, '\n').trim();
    key = (material ? Promise.resolve() : Promise.reject(new Error('JWT_PRIVATE_KEY is not set.')))
      .then(() => crypto.subtle.importKey('raw', encoder.encode(material), 'HKDF', false, ['deriveBits']))
      .then(hkdf => crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode('token-encryption') },
        hkdf,
        256,
      ))
      .then(bits => new Uint8Array(bits));
    keys.set(secret, key);
    key.catch(() => keys.delete(secret));
  }
  return key;
}

/**
 * Tokens are encrypted JWTs (JWE, `dir` + `A256GCM`): only the Worker can read what's in them, and GCM's
 * authentication tag proves the Worker made them, so no signature is nested inside. The type travels in the protected
 * header (`t`), which the tag covers too. The frontend treats every token as an opaque string.
 */
export const createJwtHelpers = ({ privateKey, issuer }: { privateKey: string, issuer: string }): JwtHelpers => ({
  issueToken: async (type, payload, options = {}) => {
    const jwt = new jose.EncryptJWT({ ...payload })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ: 'JWT', t: type })
      .setIssuer(issuer)
      .setIssuedAt();
    if (options.ttl) {
      jwt.setExpirationTime(Math.floor(Date.now() / 1000) + options.ttl);
    }
    return await jwt.encrypt(await tokenKey(privateKey));
  },

  jwtVerify: async <P extends TokenPayload>(token: string, type: TokenType, options: VerifyTokenOptions = {}) => {
    const { payload, protectedHeader } = await jose.jwtDecrypt(token, await tokenKey(privateKey), {
      issuer,
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
      ...(options.expiredFor ? { clockTolerance: options.expiredFor } : {}),
    });
    if (protectedHeader.t !== type) {
      throw new Error(`Expected a ${type} token.`);
    }
    return payload as unknown as P;
  },
});

/** Whether a token was refused only because it has expired. */
export const isExpiredToken = (error: unknown) => error instanceof jose.errors.JWTExpired;
