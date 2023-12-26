import { PersonalizationData } from "@sendgrid/helpers/classes/personalization";
import Sendgrid from "@sendgrid/mail";
import { NextFunction, Request, Response } from "express";
import { Db, MongoClient } from "mongodb";

import { Token, TokenPayload, TokenValue, encoderFactory } from "src/utils/jwt";

import { from, domain } from "src/config.json";

export interface RequestContext {
  getDbConnection: () => Promise<Db>;
  sendMail: (templateId: string, to: PersonalizationData | PersonalizationData[]) => Promise<void>;
  makeToken: <T extends string, P extends TokenPayload = TokenPayload>(token: Token<T, P>) => Promise<TokenValue>;
}

type Props = {
  mongoClient: MongoClient;
  sendgridApiKey: string;
  privateKey: string;
};

export const commonContext = ({ mongoClient, sendgridApiKey, privateKey }: Props) => {
  let dbConn: MongoClient;

  Sendgrid.setApiKey(sendgridApiKey);

  return (req: Request, res: Response, next: NextFunction) => {
    req.context = {
      getDbConnection: async () => {
        if (!dbConn) {
          dbConn = await mongoClient.connect();
        }

        return dbConn.db();
      },

      sendMail: async (templateId: string, to: PersonalizationData | PersonalizationData[]) => {
        const personalizations = Array.isArray(to) ? to : [to];
        const isMultiple = personalizations.length > 1;
        await Sendgrid.send({ templateId, from, personalizations, isMultiple });
      },

      makeToken: encoderFactory({ domain, privateKey }),
    };

    next();
  };
};

export const commonHelpers = () => {
  return (req: Request, res: Response, next: NextFunction) => {
    res.ok = (data?: any, status: number = 200) => {
      res.status(status).json({
        status: 'ok',
        ...data,
      });
    };

    res.die = (data?: any, status: number = 400) => {
      res.status(status).json({
        status: 'error',
        ...data,
      });
    };

    next();
  };
};

export const commonHeaders = () => (req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Developed-By', 'Made with love in Canada by Ugly Unicorn (https://uglyunicorn.ca)');
  res.setHeader('X-Powered-By', 'Maple syrup and magic, eh!');

  next();
};
