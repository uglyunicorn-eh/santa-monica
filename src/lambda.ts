import 'source-map-support/register';
import serverlessExpress from '@codegenie/serverless-express';
import { app } from '.';

export const handler = serverlessExpress({ app });
