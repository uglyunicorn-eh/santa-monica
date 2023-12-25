import { NextFunction, Request, Response } from "express";
import { Db, MongoClient } from "mongodb";

export interface RequestContext {
  getDbConnection: () => Promise<Db>;
}

type Props = {
  mongoClient: MongoClient;
};

export const commonContext = ({ mongoClient }: Props) => {
  let dbConn: MongoClient;

  return (req: Request, res: Response, next: NextFunction) => {
    req.context = {
      getDbConnection: async () => {
        if (!dbConn) {
          dbConn = await mongoClient.connect();
        }

        return dbConn.db();
      }
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
