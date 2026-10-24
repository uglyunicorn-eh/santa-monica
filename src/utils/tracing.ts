import { tracing } from 'cloudflare:workers';

export type SpanAttributes = Record<string, string | number | boolean | undefined>;

type ResultPayload = {
  status?: string;
  userErrors?: { fieldName: string | null }[] | null;
};

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

/** Records the outcome of a mutation payload: `api.status`, and the fields of any user errors. */
export function recordResult(span: Span, payload: ResultPayload) {
  const fields = (payload.userErrors ?? []).map(e => e.fieldName ?? '-');
  span.setAttributes({
    'api.status': payload.status ?? 'ok',
    'api.user_error_fields': fields.length ? fields.join(',') : undefined,
  });
}

/** Adds attributes to the span of the API action being handled. */
export function annotate(attributes: SpanAttributes) {
  tracing.getActiveSpan()?.setAttributes(attributes);
}
