import { ApolloContext } from "src/apollo/context";
import { MutationInput, Node, NodeMutationPayload } from 'src/apollo/types';
import { recordResult, withSpan } from 'src/utils/tracing';

/** What resolvable needs from a yup object schema. */
type InputSchema = {
  validate(value: unknown): Promise<unknown>;
  cast(value: unknown): unknown;
};

/**
 * Wraps a mutation: validates and casts its input, and runs it inside an `api.<action>` span that records the
 * outcome (status and user error fields).
 */
export default function resolvable(schema: InputSchema, action: string) {
  return <I, T extends Node>(
    ƒ: (input: I, context: ApolloContext) => Promise<Partial<NodeMutationPayload<T>>>,
  ) => {
    return async ({ input }: MutationInput<I>, context: ApolloContext) =>
      withSpan(`api.${action}`, { 'api.action': action, 'user.id': context.userId }, async span => {
        let result: Partial<NodeMutationPayload<T>>;
        try {
          await schema.validate(input);
          result = { status: 'ok', userErrors: null, ...await ƒ(schema.cast(input) as I, context) };
        } catch (error: any) {
          if (error?.name !== 'ValidationError') {
            throw error;
          }
          result = {
            status: 'error',
            userErrors: [{
              fieldName: error.path,
              messages: error.errors,
            }],
          };
        }
        recordResult(span, result);
        return result;
      });
  };
}
