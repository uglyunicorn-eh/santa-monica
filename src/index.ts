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
    integrations: [
      // enable HTTP calls tracing
      new Sentry.Integrations.Http({ tracing: true }),
      // enable Express.js middleware tracing
      new Sentry.Integrations.Express({ app }),
    ],
    tracesSampleRate: 1.0,
  });

  // The request handler must be the first middleware on the app
  app.use(Sentry.Handlers.requestHandler());

  // TracingHandler creates a trace for every incoming request
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


if (SENTRY_DSN) {
  // The error handler must be registered before any other error middleware and after all controllers
  app.use(Sentry.Handlers.errorHandler());

  // Optional fallthrough error handler
  // app.use(function onError(err, req, res, next) {
  //   // The error id is attached to `res.sentry` to be returned
  //   // and optionally displayed to the user for support.
  //   res.statusCode = 500;
  //   res.end(res.sentry + "\n");
  // });
}

if (port) {
  app.listen(port, () => {
    console.log(`[server]: Server is running at http://localhost:${port}`);
  });
}
