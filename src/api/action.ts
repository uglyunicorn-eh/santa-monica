import { ApiContext } from 'src/api/context';
import { ApiError, errorResponse } from 'src/api/errors';
import { recordOutcome, withSpan } from 'src/utils/tracing';

/**
 * Runs a route inside an `api.<name>` span that records the outcome (`api.status`, and the error's code and field).
 * Expected failures (ApiError) become their status and error body; anything else goes on to the app's error handler,
 * which hides it behind a 500 and an error id.
 */
export const action = (name: string, handler: (c: ApiContext, span: Span) => Promise<Response>) =>
  (c: ApiContext) => withSpan(`api.${name}`, { 'api.action': name, 'user.id': c.get('session')?.userId }, async span => {
    try {
      const res = await handler(c, span);
      recordOutcome(span);
      return res;
    } catch (error) {
      if (error instanceof ApiError) {
        recordOutcome(span, error);
        return errorResponse(c, error);
      }
      throw error;
    }
  });
