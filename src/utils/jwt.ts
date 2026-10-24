import * as jose from 'jose';

export type IssuedAt = {
  iat: number,
};

export type ExpiredAt = {
  exp: number,
};

export type TokenPayload = Partial<IssuedAt & ExpiredAt>;
export type TokenValue = string;

export type IssueTokenOptions = {
  ttl?: number;
};

export type TokenType = 'EnterRequest' | 'UserToken';

export type JwtHelpers = {
  issueToken: <P extends TokenPayload = TokenPayload>(type: TokenType, payload: P, options?: IssueTokenOptions) => Promise<TokenValue>;
  jwtVerify: <P extends TokenPayload = TokenPayload>(token: string, type: TokenType) => Promise<P>;
};

export const createJwtHelpers = ({ secret, issuer }: { secret: string, issuer: string }): JwtHelpers => {
  const key = new TextEncoder().encode(secret);

  return {
    issueToken: async (type, payload, options = {}) => {
      const jwt = new jose.SignJWT({ ...payload })
        .setProtectedHeader({ typ: 'JWT', alg: 'HS256', t: type })
        .setIssuer(issuer)
        .setIssuedAt();
      if (options.ttl) {
        jwt.setExpirationTime(Math.floor(Date.now() / 1000) + options.ttl);
      }
      return await jwt.sign(key);
    },

    jwtVerify: async <P extends TokenPayload>(token: string, type: TokenType) => {
      const { payload, protectedHeader } = await jose.jwtVerify(token, key, { issuer, algorithms: ['HS256'] });
      if (protectedHeader.t !== type) {
        throw new Error(`Expected a ${type} token.`);
      }
      return payload as unknown as P;
    },
  };
};
