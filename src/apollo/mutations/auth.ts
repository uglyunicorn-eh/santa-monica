import _ from 'src/utils/graphql/resolvable';
import { ApolloContext } from 'src/apollo/context';

import { enterInputSchema } from './validation';
import { EnterInput } from './types';

import { baseUrl } from 'src/config.json';

export default {
  auth: () => ({

    enter: _(enterInputSchema)(async (input: EnterInput, { db, user, sendMail }: ApolloContext) => {
      if (!user) {
        await sendMail(
          'd-2b7845c2dfec4068aa2d25496516262f',
          {
            to: input.email,
            dynamicTemplateData: {
              magicLink: `${baseUrl}/link/NBGYo78puio.HGF&Ttghhg5678il.sfasdh`,
            },
          },
        );
      }

      return {};
    }),

  }),
};
