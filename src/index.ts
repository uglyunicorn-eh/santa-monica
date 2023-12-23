import cors from "cors";
import dotenv from "dotenv";
import express, { Express, Request, Response } from "express";
import helmet from "helmet";
import morgan from "morgan";

import { commonHeaders } from "src/utils/express/commonHeaders";

dotenv.config();

const port = process.env.PORT;

export const app: Express = express();

app.use(morgan("dev"));
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(commonHeaders());

app.get("/", (req: Request, res: Response) => {
  res.json({
    hello: "world",
    this: "is good!!!",
  });
});


if (port) {
  app.listen(port, () => {
    console.log(`[server]: Server is running at http://localhost:${port}`);
  });
}
