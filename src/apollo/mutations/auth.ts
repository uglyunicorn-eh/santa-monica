import _ from 'src/utils/graphql/resolvable';
import { ApolloContext } from 'src/apollo/context';

import { enterInputSchema } from './validation';
import { EnterInput } from './types';

import { baseUrl, sendgridTemplates } from 'src/config.json';

export default {
  auth: () => ({

    enter: _(enterInputSchema)(async (input: EnterInput, { db, user, sendMail }: ApolloContext) => {
      if (!user) {
        const token = '';

        await sendMail(
          sendgridTemplates.signIn,
          {
            to: input.email,
            dynamicTemplateData: {
              magicLink: `${baseUrl}/enter/${token}`,
            },
          },
        );
      }

      return {};
    }),

  }),
};
