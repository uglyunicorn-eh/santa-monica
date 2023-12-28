import * as jose from "jose";
import { Request } from "express";
import { BaseContext } from "@apollo/server";
import { Db, ObjectId } from "mongodb";
import { PersonalizationData } from "@sendgrid/helpers/classes/personalization";

import { TokenPayload, TokenValue, createPrivateKey } from "src/utils/jwt";

import { domain } from 'src/config.json';
import { UserEntity } from "src/models";

const privateKey = process.env.RSA_PRIVATE_KEY!.split('\\n').join('\n');
const rsaPrivateKey = createPrivateKey(privateKey);

export type IssueTokenOptions = {
  ttl?: number;
}

export interface ApolloContext extends BaseContext {
  db: Db;
  authToken?: string;
  userId?: ObjectId;
  retrieveUser: () => Promise<UserEntity>;
  sendMail: (templateId: string, to: PersonalizationData | PersonalizationData[]) => Promise<void>;
  issueToken: <P extends TokenPayload = TokenPayload>(type: string, payload: P, options?: IssueTokenOptions) => Promise<TokenValue>;
  jwtVerify: <P extends TokenPayload = TokenPayload>(token: string) => Promise<P>;
};

export const makeContext = async ({ req }: { req: Request }): Promise<ApolloContext> => {
  const jwtVerify = async <P extends TokenPayload = TokenPayload>(token: string) => {
    const jwtToken = await jose.jwtVerify<P>(token, rsaPrivateKey, { issuer: domain });
    return jwtToken.payload;
  };

  const issueToken = async <P extends TokenPayload = TokenPayload>(type: string, payload: P, options?: IssueTokenOptions) => {
    options = options || {};
    return req.context.makeToken({
      header: {
        typ: "JWT",
        alg: "RS256",
        t: type,
      },
      payload: {
        ...payload,
        ...(options.ttl ? { exp: Math.floor(Date.now() / 1000) + options.ttl } : {}),
      },
    });
  };

  return {
    db: await req.context.getDbConnection(),
    authToken: req.headers.authorization?.split(' ')[1],
    userId: undefined,
    retrieveUser: async () => { throw new Error("Unable to retrieve user"); },
    sendMail: req.context.sendMail,
    issueToken,
    jwtVerify,
  };
};
