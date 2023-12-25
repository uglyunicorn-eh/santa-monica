import _ from 'src/utils/graphql/resolvable';
import { ApolloContext } from 'src/apollo/context';
import Sendgrid from '@sendgrid/mail';

import { enterInputSchema } from './validation';
import { EnterInput } from './types';

export default {
  auth: () => ({

    enter: _(enterInputSchema)(async (input: EnterInput, { db, user }: ApolloContext) => {
      if (!user) {
        console.log({ input });

        Sendgrid.setApiKey(process.env.SENDGRID_API_KEY!);

        const res = await Sendgrid.send({
          templateId: 'd-2b7845c2dfec4068aa2d25496516262f',
          from: {
            name: 'Anonymous Ded Morozes',
            email: 'info@gnomik.me',
          },
          personalizations: [
            {
              to: input.email,
              dynamicTemplateData: {
                magicLink: 'https://gnomik.me/link/MAGICLINK123',
              },
            },
          ],
          isMultiple: true,
        });

        console.log({ res });
      }
      return {};
    }),

  }),
};
