import * as crypto from 'crypto';

export type IssuedAt = {
  iat: number,
};

export type ExpiredAt = {
  exp: number,
};

export type TokenPayload = Partial<IssuedAt & ExpiredAt>;
export type TokenValue = string;

export type EncoderOptions = {
  domain: string,
  privateKey: string,
};

export type TokenValueEncoder<T extends string, P extends TokenPayload> = (token: Token<T, P>) => Promise<TokenValue>;

export type Token<T extends string, P extends TokenPayload = TokenPayload> = {
  header: {
    typ: "JWT",
    alg: "RS256",
    _: string,
    t: T,
  },
  payload: P,
  value?: TokenValue,
};

export const encoderFactory = <T extends string, P extends TokenPayload = TokenPayload>(options: EncoderOptions): TokenValueEncoder<T, P> => {
  return async (token: Token<T, P>) => {
    return await encode(
      {
        ...token,
        header: {
          ...token.header,
          _: crypto.randomBytes(8).toString('hex'),
        },
        payload: {
          ...token.payload,
          iss: options.domain,
          iat: Math.floor(Date.now() / 1000),
        },
      },
      options.privateKey,
    );
  }
};

const encode = async<T extends string, P extends TokenPayload>(token: Token<T, P>, privateKey: string): Promise<string> => {
  const key = await createPrivateKey(privateKey);

  const _ = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

  const data = `${_(token.header)}.${_(token.payload)}`;
  const sig = crypto.createSign('RSA-SHA256').update(`${data}`).sign(key).toString('base64url');

  return `${data}.${sig}`;
};

const createPrivateKey = async (privateKey: string): Promise<crypto.KeyObject> => {
  return crypto.createPrivateKey({
    key: Buffer.from(privateKey),
  });
}
