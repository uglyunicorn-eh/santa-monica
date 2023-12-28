import { expressMiddleware } from '@apollo/server/express4';
import * as Sentry from '@sentry/node';
import cors from "cors";
import dotenv from "dotenv";
import express, { Express, Request, Response } from "express";
import helmet from "helmet";
import * as jose from "jose";
import { MongoClient } from 'mongodb';
import morgan from "morgan";

import { createServer } from 'src/apollo';
import { commonContext, commonHeaders, commonHelpers } from "src/utils/express";
import { TokenPayload, createPrivateKey } from 'src/utils/jwt';

import { author, name, version } from 'package.json';
import { IssueTokenOptions } from 'src/apollo/context';
import { domain } from 'src/config.json';

dotenv.config();

const SENTRY_DSN = process.env.SENTRY_DSN;
const MONGODB_URI = process.env.MONGODB_URI!;
const PORT = process.env.PORT;

const privateKey = process.env.RSA_PRIVATE_KEY!.split('\\n').join('\n');
const sendgridApiKey = process.env.SENDGRID_API_KEY!;

const mongoClient = new MongoClient(MONGODB_URI);
const rsaPrivateKey = createPrivateKey(privateKey);

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
    app.use(commonContext({
      mongoClient,
      sendgridApiKey,
      privateKey,
    }));
  }
  catch (error) {
    Sentry.captureException(error);
  }

  app.get(
    "/",
    async (req: Request, res: Response) => {
      return res.ok({ name, version, author });
    },
  );

  app.all(
    "/graph",
    expressMiddleware(
      await createServer(),
      {
        context: async ({ req }) => ({
          db: await req.context.getDbConnection(),
          user: null as any,

          sendMail: req.context.sendMail,

          issueToken: async <P extends TokenPayload = TokenPayload>(type: string, payload: P, options?: IssueTokenOptions) => {
            options = options || {};
            return req.context.makeToken({
              header: {
                typ: "JWT",
                alg: "RS256",
                t: type,
              },
              payload: {
                ...payload,
                ...(options.ttl ? { exp: Math.floor(Date.now() / 1000) + options.ttl } : {}),
              },
            });
          },

          jwtVerify: async <P extends TokenPayload = TokenPayload>(token: string) => {
            const jwtToken = await jose.jwtVerify<P>(token, rsaPrivateKey, { issuer: domain });
            return jwtToken.payload;
          },
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

  if (PORT) {
    app.listen(PORT, () => {
      console.log(`[server]: Server is running at http://localhost:${PORT}`);
    });
  }

})();
