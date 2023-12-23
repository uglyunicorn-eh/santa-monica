import serverlessExpress from '@codegenie/serverless-express';
// import { ProfilingIntegration } from "@sentry/profiling-node";
// import Sentry from "@sentry/serverless";
import 'source-map-support/register';
import { app } from '.';

const SENTRY_DSN = process.env.SENTRY_DSN;

let lambdaHandler: any = serverlessExpress({ app });

if (SENTRY_DSN) {
  // Sentry.AWSLambda.init({
  //   dsn: SENTRY_DSN,
  //   // integrations: [
  //   //   new ProfilingIntegration(),
  //   // ],
  //   // // Performance Monitoring
  //   // tracesSampleRate: 1.0,
  //   // // Set sampling rate for profiling - this is relative to tracesSampleRate
  //   // profilesSampleRate: 1.0,
  // });
  // lambdaHandler = Sentry.AWSLambda.wrapHandler(lambdaHandler);
}

export const handler = lambdaHandler;
