import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Error codes and the HTTP status each one answers with. 401 is only ever "the session is missing, invalid or
 * revoked": the frontend signs out on it, so emailed-link problems have codes of their own.
 */
export const ERROR_STATUS = {
  invalid: 400,
  invalid_link: 400,
  link_expired: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  link_used: 409,
  account_busy: 409,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
  not_finished: 503,
} as const satisfies Record<string, ContentfulStatusCode>;

export type ErrorCode = keyof typeof ERROR_STATUS;

export type ErrorBody = { error: { code: ErrorCode; message: string; field?: string } };

/**
 * An expected failure: answered with its status and `{ error: { code, message, field } }`, and with `Retry-After` when
 * `retryAfter` (seconds) says when to try again.
 */
export class ApiError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly field?: string, readonly retryAfter?: number) {
    super(message);
  }

  get status() {
    return ERROR_STATUS[this.code];
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.field ? { field: this.field } : {}) } };
  }
}

export const fail = (code: ErrorCode, message: string, field?: string) => new ApiError(code, message, field);

/** The one way an ApiError becomes a response: its status, its body, and `Retry-After` when it has one. */
export function errorResponse(c: Context, error: ApiError): Response {
  if (error.retryAfter !== undefined) {
    c.header('Retry-After', String(error.retryAfter));
  }
  return c.json(error.toBody(), error.status);
}

export const notSignedIn = () => fail('unauthenticated', 'Your session has expired. Please sign in again.');
