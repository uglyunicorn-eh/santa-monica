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

export type TokenType = 'EnterRequest' | 'UserToken';

export type JwtHelpers = {
  issueToken: <P extends TokenPayload = TokenPayload>(type: TokenType, payload: P, options?: IssueTokenOptions) => Promise<TokenValue>;
  jwtVerify: <P extends TokenPayload = TokenPayload>(token: string, type: TokenType) => Promise<P>;
};

type KeyPair = { privateKey: CryptoKey; publicKey: CryptoKey };

const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

const derLength = (length: number): number[] => {
  if (length < 0x80) {
    return [length];
  }
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) {
    bytes.unshift(n & 0xff);
  }
  return [0x80 | bytes.length, ...bytes];
};

const der = (tag: number, content: Uint8Array) => new Uint8Array([tag, ...derLength(content.length), ...content]);

/** Wraps a PKCS#1 RSA private key (BEGIN RSA PRIVATE KEY) in a PKCS#8 envelope, which WebCrypto can import. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaEncryption = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  return der(0x30, new Uint8Array([...version, ...rsaEncryption, ...der(0x04, pkcs1)]));
}

/** Imports an RSA private key from PEM (PKCS#8 or PKCS#1, with real or escaped "\n" line breaks) and derives its public key. */
export async function importRsaKeyPair(pem: string): Promise<KeyPair> {
  const text = pem.replace(/\\n/g, '\n');
  const body = text.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '');
  const bytes = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  const pkcs8 = text.includes('BEGIN RSA PRIVATE KEY') ? pkcs1ToPkcs8(bytes) : bytes;

  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, RS256, true, ['sign']);
  const { kty, n, e } = await crypto.subtle.exportKey('jwk', privateKey) as JsonWebKey;
  const publicKey = await crypto.subtle.importKey('jwk', { kty, n, e, alg: 'RS256', ext: true }, RS256, true, ['verify']);
  return { privateKey, publicKey };
}

const keyPairs = new Map<string, Promise<KeyPair>>();

const keyPairFor = (pem: string) => {
  let keyPair = keyPairs.get(pem);
  if (!keyPair) {
    keyPair = importRsaKeyPair(pem);
    keyPairs.set(pem, keyPair);
    keyPair.catch(() => keyPairs.delete(pem));
  }
  return keyPair;
};

/**
 * Tokens are RS256, signed with JWT_PRIVATE_KEY. The frontend verifies them in the browser with the matching public
 * key (its PUBLIC_KEY build variable), so the key pair has to stay in sync with the frontend.
 */
export const createJwtHelpers = ({ privateKey, issuer }: { privateKey: string, issuer: string }): JwtHelpers => ({
  issueToken: async (type, payload, options = {}) => {
    const jwt = new jose.SignJWT({ ...payload })
      .setProtectedHeader({ typ: 'JWT', alg: 'RS256', t: type })
      .setIssuer(issuer)
      .setIssuedAt();
    if (options.ttl) {
      jwt.setExpirationTime(Math.floor(Date.now() / 1000) + options.ttl);
    }
    return await jwt.sign((await keyPairFor(privateKey)).privateKey);
  },

  jwtVerify: async <P extends TokenPayload>(token: string, type: TokenType) => {
    const { publicKey } = await keyPairFor(privateKey);
    const { payload, protectedHeader } = await jose.jwtVerify(token, publicKey, { issuer, algorithms: ['RS256'] });
    if (protectedHeader.t !== type) {
      throw new Error(`Expected a ${type} token.`);
    }
    return payload as unknown as P;
  },
});
