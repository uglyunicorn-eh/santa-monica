import { tracing } from 'cloudflare:workers';

export type SpanAttributes = Record<string, string | number | boolean | undefined>;

/**
 * Runs `fn` inside a custom span (Workers tracing, exported to Better Stack). Platform calls made inside, such as
 * Durable Object RPCs and fetches, become child spans. Thrown errors are recorded on the span and rethrown.
 * Attributes must not carry personal data (emails, names): use ids.
 */
export function withSpan<T>(name: string, attributes: SpanAttributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracing.enterSpan(name, async span => {
    span.setAttributes(attributes);
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      throw error;
    }
  });
}

/**
 * Records how an API action ended: `api.status` (ok or error), and for an expected failure its code and the field it
 * is about (`api.user_error_fields`, "-" when it is about no field, as before).
 */
export function recordOutcome(span: Span, error?: { code: string; field?: string }) {
  span.setAttributes({
    'api.status': error ? 'error' : 'ok',
    'api.error_code': error?.code,
    'api.user_error_fields': error ? (error.field ?? '-') : undefined,
  });
}

/** Adds attributes to the span of the API action being handled. */
export function annotate(attributes: SpanAttributes) {
  tracing.getActiveSpan()?.setAttributes(attributes);
}
