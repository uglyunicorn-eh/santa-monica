import { BaseContext } from "@apollo/server";
import { Db } from "mongodb";

export interface ApolloContext extends BaseContext {
  db: Db,
  user?: any,
};
