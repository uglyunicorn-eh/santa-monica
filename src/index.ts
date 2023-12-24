import { expressMiddleware } from '@apollo/server/express4';
import * as Sentry from '@sentry/node';
import cors from "cors";
import dotenv from "dotenv";
import express, { Express, Request, Response } from "express";
import helmet from "helmet";
import { Db, MongoClient } from 'mongodb';
import morgan from "morgan";

import { createServer } from 'src/apollo';
import { commonContext, commonHeaders, commonHelpers } from "src/utils/express";

import { author, name, version } from 'package.json';

dotenv.config();

const SENTRY_DSN = process.env.SENTRY_DSN;
const MONGODB_URI = process.env.MONGODB_URI!;
const port = process.env.PORT;

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

  let db: Db;

  try {
    // db = await mongoClient.connect();
    // app.use(commonContext({ db }));
  }
  catch (error) {
    Sentry.captureException(error);
  }

  app.get(
    "/",
    async (req: Request, res: Response) => {
      // const db = req.context.db;
      // try {
      //   const db = await mongoClient.connect();
      //   const parties = await db.db().collection('Party').find().toArray();
      //   return res.ok({ parties });
      // }
      // catch (error) {
      //   return res.die({ error }, 500);
      // }

      // const parties = await db.collection('Party').find().toArray();
      const parties = null;

      res.ok({ name, version, author, parties });
    },
  );

  app.all(
    "/graph",
    expressMiddleware(
      await createServer(),
      {
        context: async () => ({
          db,
        }),
      },
    ),
  );

  app.get(
    "/fail",
    (_: Request, res: Response) => {
      const error = "Don't panic! This is a drill! Piu-piu-piu!";
      res.die({ error }, 500);
      Sentry.captureMessage(error);
    },
  );

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

})();
