import serverlessExpress from '@codegenie/serverless-express';
import * as Sentry from "@sentry/serverless";
import 'source-map-support/register';
import { app } from '.';

const SENTRY_DSN = process.env.SENTRY_DSN;

let lambdaHandler: any = serverlessExpress({ app });

if (SENTRY_DSN) {
  Sentry.AWSLambda.init({
    dsn: SENTRY_DSN,
    release: `${process.env.npm_package_name}@${process.env.npm_package_version}`,
    environment: process.env.NODE_ENV,
    // Performance Monitoring
    tracesSampleRate: 1.0,
    // Set sampling rate for profiling - this is relative to tracesSampleRate
    profilesSampleRate: 1.0,
  });
  lambdaHandler = Sentry.AWSLambda.wrapHandler(lambdaHandler);
}

export const handler = lambdaHandler;
