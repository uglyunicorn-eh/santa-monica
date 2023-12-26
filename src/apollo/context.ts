import { BaseContext } from "@apollo/server";
import { Db } from "mongodb";
import { PersonalizationData } from "@sendgrid/helpers/classes/personalization";

import { TokenPayload, TokenValue } from "src/utils/jwt";

export type IssueTokenOptions = {
  ttl?: number;
}

export interface ApolloContext extends BaseContext {
  db: Db;
  user?: any;
  sendMail: (templateId: string, to: PersonalizationData | PersonalizationData[]) => Promise<void>;
  issueToken: <P extends TokenPayload = TokenPayload>(type: string, payload: P, options?: IssueTokenOptions) => Promise<TokenValue>;
};
