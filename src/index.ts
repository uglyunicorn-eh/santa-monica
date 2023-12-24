import * as Sentry from '@sentry/node';
import cors from "cors";
import dotenv from "dotenv";
import express, { Express, Request, Response } from "express";
import helmet from "helmet";
import morgan from "morgan";

import { commonHeaders } from "src/utils/express/commonHeaders";

import PACKAGE from 'package.json';

dotenv.config();

const SENTRY_DSN = process.env.SENTRY_DSN;
const port = process.env.PORT;

export const app: Express = express();

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    release: `${PACKAGE.name}@${PACKAGE.version}`,
    environment: process.env.NODE_ENV,
    integrations: [
      new Sentry.Integrations.Http({ tracing: true }),
      new Sentry.Integrations.Express({ app }),
    ],
    tracesSampleRate: 1.0,
  });
  app.use(Sentry.Handlers.requestHandler());
  app.use(Sentry.Handlers.tracingHandler());
}

app.use(morgan("dev"));
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(commonHeaders());

app.get("/", (req: Request, res: Response) => {
  res.json({
    version: `${PACKAGE.name}@${PACKAGE.version}`,
  });
});

app.get("/fail", (req: Request, res: Response) => {
  throw new Error("Don't panic! This is a drill! Piu-piu-piu!");

});

if (SENTRY_DSN) {
  app.use(Sentry.Handlers.errorHandler());
}

app.use((_err: any, req: any, res: any, _next: any) => {
  res.die({ error: 'Ugly Unicorn just puked a little bit :(', errorId: req.sentry }, 500);
});

if (port) {
  app.listen(port, () => {
    console.log(`[server]: Server is running at http://localhost:${port}`);
  });
}
