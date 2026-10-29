import { annotate } from 'src/utils/tracing';

/**
 * Durable Object errors Cloudflare says are worth one more try: `retryable` (a transient fault, such as the object
 * being reset after an internal storage error) and not `overloaded` (retrying only adds to the load).
 */
export const isRetryable = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { retryable?: unknown }).retryable === true
  && (error as { overloaded?: unknown }).overloaded !== true;

/**
 * Runs a read from a Durable Object, once more after a transient fault (`isRetryable`). `read` is called again from
 * scratch, so it gets a fresh stub: a stub that failed may stay broken. Only for reads, which are safe to repeat; the
 * second failure, or any other error, goes on as it was. The span records `do.retried`.
 */
export async function retryRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!isRetryable(error)) {
      throw error;
    }
    annotate({ 'do.retried': true });
    return read();
  }
}
