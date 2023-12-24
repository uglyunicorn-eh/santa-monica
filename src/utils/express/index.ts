import { NextFunction, Request, Response } from "express";
import { Db } from "mongodb";

export interface RequestContext {
  db: Db;
}

type Props = {
  db: Db;
};

export const commonHelpers = ({ db }: Props) => {
  return (req: Request, res: Response, next: NextFunction) => {
    req.context = {
      db,
    };

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
