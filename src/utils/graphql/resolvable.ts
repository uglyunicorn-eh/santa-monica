
import { ApolloContext } from "src/apollo/context";
import { MutationInput, Node, NodeMutationPayload } from 'src/apollo/types';

/** What resolvable needs from a yup object schema. */
type InputSchema = {
  validate(value: unknown): Promise<unknown>;
  cast(value: unknown): unknown;
};

export default function resolvable(schema: InputSchema) {
  return <I, T extends Node>(
    ƒ: (input: I, context: ApolloContext) => Promise<Partial<NodeMutationPayload<T>>>,
  ) => {
    return async ({ input }: MutationInput<I>, context: ApolloContext) => {
      try {
        await schema.validate(input);
      } catch ({ path, errors }: any) {
        return {
          status: 'error',
          userErrors: [{
            fieldName: path,
            messages: errors,
          }],
        };
      }
      const data = schema.cast(input) as any;
      return {
        status: 'ok',
        userErrors: null,
        ...await Promise.resolve(ƒ(data, context)),
      };
    };
  };
}
