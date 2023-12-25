import { NextFunction, Request, Response } from "express";
import { MongoClient } from "mongodb";

export interface RequestContext {
  dbConn: MongoClient;
}

type Props = {
  dbConn: MongoClient;
};

export const commonContext = ({ dbConn }: Props) => {
  return (req: Request, res: Response, next: NextFunction) => {
    req.context = {
      dbConn,
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
