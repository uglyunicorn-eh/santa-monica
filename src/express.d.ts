declare namespace Express {
  export interface Response {
    ok: (obj?: any, status?: number) => void;
    die: (obj?: any, status?: number) => void;
  }

  export interface Request {
    context: RequestContext;
  }
}
