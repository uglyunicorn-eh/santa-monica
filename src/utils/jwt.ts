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

export type TokenType = 'EnterRequest' | 'UserToken' | 'AccountDeletion' | 'EmailChange' | 'EmailChangeCancel' | 'LiveTicket';

export type JwtHelpers = {
  issueToken: <P extends TokenPayload = TokenPayload>(type: TokenType, payload: P, options?: IssueTokenOptions) => Promise<TokenValue>;
  jwtVerify: <P extends TokenPayload = TokenPayload>(token: string, type: TokenType) => Promise<P>;
};

type KeyPair = { privateKey: CryptoKey; publicKey: CryptoKey };

const ES256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;

/** Imports a P-256 private key from PKCS#8 PEM (with real or escaped "\n" line breaks) and derives its public key. */
async function importEcKeyPair(pem: string): Promise<KeyPair> {
  const body = pem.replace(/\\n/g, '\n').replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '');
  const pkcs8 = Uint8Array.from(atob(body), c => c.charCodeAt(0));

  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, ES256, true, ['sign']);
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', privateKey) as JsonWebKey;
  const publicKey = await crypto.subtle.importKey('jwk', { kty, crv, x, y, ext: true }, ES256, true, ['verify']);
  return { privateKey, publicKey };
}

const keyPairs = new Map<string, Promise<KeyPair>>();

const keyPairFor = (pem: string) => {
  let keyPair = keyPairs.get(pem);
  if (!keyPair) {
    keyPair = importEcKeyPair(pem);
    keyPairs.set(pem, keyPair);
    keyPair.catch(() => keyPairs.delete(pem));
  }
  return keyPair;
};

/**
 * Tokens are ES256, signed with JWT_PRIVATE_KEY (P-256). The frontend verifies them in the browser with the matching
 * public key (publicKey in santa-barbara's src/config.json), so the key pair has to stay in sync with the frontend.
 */
export const createJwtHelpers = ({ privateKey, issuer }: { privateKey: string, issuer: string }): JwtHelpers => ({
  issueToken: async (type, payload, options = {}) => {
    const jwt = new jose.SignJWT({ ...payload })
      .setProtectedHeader({ typ: 'JWT', alg: 'ES256', t: type })
      .setIssuer(issuer)
      .setIssuedAt();
    if (options.ttl) {
      jwt.setExpirationTime(Math.floor(Date.now() / 1000) + options.ttl);
    }
    return await jwt.sign((await keyPairFor(privateKey)).privateKey);
  },

  jwtVerify: async <P extends TokenPayload>(token: string, type: TokenType) => {
    const { publicKey } = await keyPairFor(privateKey);
    const { payload, protectedHeader } = await jose.jwtVerify(token, publicKey, { issuer, algorithms: ['ES256'] });
    if (protectedHeader.t !== type) {
      throw new Error(`Expected a ${type} token.`);
    }
    return payload as unknown as P;
  },
});
