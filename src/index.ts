import { expressMiddleware } from '@apollo/server/express4';
import * as Sentry from '@sentry/node';
import cors from "cors";
import dotenv from "dotenv";
import express, { Express, Request, Response } from "express";
import helmet from "helmet";
import { MongoClient } from 'mongodb';
import morgan from "morgan";

import { createServer } from 'src/apollo';
import { makeContext } from 'src/apollo/context';
import { commonContext, commonHeaders, commonHelpers } from "src/utils/express";

import { author, name, version } from 'package.json';

dotenv.config();

const SENTRY_DSN = process.env.SENTRY_DSN;
const MONGODB_URI = process.env.MONGODB_URI!;
const PORT = process.env.PORT;

const privateKey = process.env.RSA_PRIVATE_KEY!.split('\\n').join('\n');
const sendgridApiKey = process.env.SENDGRID_API_KEY!;

const mongoClient = new MongoClient(MONGODB_URI);

export const app: Express = express();

(async function main() {

  if (SENTRY_DSN) {
    Sentry.init({
      dsn: SENTRY_DSN,
      release: `${name}@${version}`,
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
  app.use(commonHelpers());

  try {
    app.use(commonContext({ mongoClient, sendgridApiKey, privateKey }));
  }
  catch (error) {
    Sentry.captureException(error);
  }

  app.get(
    "/",
    (_: Request, res: Response) => res.ok({ name, version, author }),
  );

  app.all(
    "/graph",
    expressMiddleware(await createServer(), { context: makeContext }),
  );

  if (SENTRY_DSN) {
    app.use(Sentry.Handlers.errorHandler());
  }

  app.use((_err: any, req: any, res: any, _next: any) => {
    res.die({ error: 'Ugly Unicorn just puked a little bit :(', errorId: req.sentry }, 500);
  });

  if (PORT) {
    app.listen(PORT, () => {
      console.log(`[server]: Server is running at http://localhost:${PORT}`);
    });
  }

})();
