import { Request, Response, NextFunction } from "express";

export const commonHeaders = () => (req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Developed-By', 'Made with love in Canada by Ugly Unicorn (https://uglyunicorn.ca)');
  res.setHeader('X-Powered-By', 'Maple syrup and magic, eh!');

  next();
};
