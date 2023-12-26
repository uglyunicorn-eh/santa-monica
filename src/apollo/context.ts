import { BaseContext } from "@apollo/server";
import { Db } from "mongodb";
import { PersonalizationData } from "@sendgrid/helpers/classes/personalization";

export interface ApolloContext extends BaseContext {
  db: Db;
  user?: any;
  sendMail: (templateId: string, to: PersonalizationData | PersonalizationData[]) => Promise<void>;
};
