import _ from 'src/utils/graphql/resolvable';
import { ApolloContext } from 'src/apollo/context';

import { enterInputSchema } from './validation';
import { EnterInput } from './types';

export default {
  auth: () => ({

    enter: _(enterInputSchema)(async (input: EnterInput, { db, user }: ApolloContext) => {
      if (!user) {
        console.log({ input });
      }
      return {};
    }),

  }),
};
