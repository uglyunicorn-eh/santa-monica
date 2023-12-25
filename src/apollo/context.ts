import { MongoClient } from "mongodb";

export type ApolloContext = {
  dbConn: MongoClient,
};
