import _ from 'src/utils/graphql/resolvable';
import { ApolloContext } from 'src/apollo/context';

import { TokenPayload } from 'src/utils/jwt';

import { enterInputSchema } from './validation';
import { EnterRequestInput } from './types';

import { baseUrl, sendgridTemplates } from 'src/config.json';

interface EnterRequestToken extends TokenPayload {
  email: string;
  party?: string;
}

export default {
  auth: () => ({

    enterRequest: _(enterInputSchema)(async (input: EnterRequestInput, context: ApolloContext) => {
      const { db, user, sendMail, issueToken } = context;

      if (!user) {
        const tokenPayload = {
          email: input.email,
          ...(input.party && { party: input.party })
        }
        const token = await issueToken<EnterRequestToken>("EnterRequest", tokenPayload, { ttl: 300 });

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
