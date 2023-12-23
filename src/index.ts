import { RewriteFrames } from '@sentry/integrations';
import * as Sentry from '@sentry/node';
import cors from "cors";
import dotenv from "dotenv";
import express, { Express, Request, Response } from "express";
import helmet from "helmet";
import morgan from "morgan";

import { commonHeaders } from "src/utils/express/commonHeaders";

import PACKAGE from 'package.json';

const SENTRY_DSN = process.env.SENTRY_DSN;

dotenv.config();

const port = process.env.PORT;

export const app: Express = express();

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    release: `${PACKAGE.name}@${PACKAGE.version}`,
    environment: process.env.NODE_ENV,
    integrations: [new RewriteFrames()],
    tracesSampleRate: 1.0,
    profilesSampleRate: 1.0,
  });
  app.use(Sentry.Handlers.requestHandler());
}

app.use(morgan("dev"));
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(commonHeaders());

app.get("/", (req: Request, res: Response) => {
  res.json({
    hello: "world",
    this: "is good!!!",
    env: `${PACKAGE.name}@${PACKAGE.version}`,
  });
});

app.get("/error", (req: Request, res: Response) => {
  throw new Error("Don't panic it's a drill.");
});

if (port) {
  app.listen(port, () => {
    console.log(`[server]: Server is running at http://localhost:${port}`);
  });
}
