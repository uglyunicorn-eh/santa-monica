import { ApolloContext } from 'src/apollo/context';
import { viewParty } from 'src/apollo/resolvers/party';
import { EnterRequestToken, UserToken } from 'src/apollo/types';
import { renderSignIn } from 'src/mail';
import _ from 'src/utils/graphql/resolvable';
import { nodeIdToStr } from 'src/utils/strings/nodeId';

import { EnterInput, EnterRequestInput } from './types';
import { enterInputSchema, enterRequestInputSchema } from './validation';

import { baseUrl } from 'src/config.json';

const tooManyRequests = {
  status: 'error' as const,
  userErrors: [{
    fieldName: 'email',
    messages: ["Whoa, that's a lot of magic links! Please wait a minute and try again."],
  }],
};

export default {
  auth: () => ({

    enterRequest: _(enterRequestInputSchema)(async (input: EnterRequestInput, context: ApolloContext) => {
      const { env, clientIp, sendMail, issueToken } = context;
      const email = input.email.toLowerCase();

      const [byIp, byEmail] = await Promise.all([
        env.ENTER_RATE_LIMIT_IP.limit({ key: clientIp }),
        env.ENTER_RATE_LIMIT_EMAIL.limit({ key: email }),
      ]);
      if (!byIp.success || !byEmail.success) {
        return tooManyRequests;
      }

      if (input.party) {
        const party = await viewParty(env, input.party);
        if (!party) {
          return {
            status: 'error',
            userErrors: [{
              fieldName: 'party',
              messages: ["Invalid party code."],
            }],
          };
        }
      }

      const tokenPayload = {
        email,
        ...(input.party ? { party: input.party } : {})
      }
      const token = await issueToken<EnterRequestToken>("EnterRequest", tokenPayload, { ttl: 300 });

      try {
        await sendMail(email, renderSignIn({ magicLink: `${baseUrl}/enter/${token}`, assetsUrl: env.PUBLIC_URL }));
      } catch (error) {
        console.error('Unable to send the magic link', String(error));
        return {
          status: 'error',
          userErrors: [{
            fieldName: 'email',
            messages: ["We couldn't send the magic link right now. Please try again in a few minutes."],
          }],
        };
      }

      return {};
    }),

    enter: _(enterInputSchema)(async (input: EnterInput, context: ApolloContext) => {
      const { env, jwtVerify, issueToken } = context;

      const { enterRequestToken } = input;

      try {
        const jwtToken = await jwtVerify<EnterRequestToken>(enterRequestToken, 'EnterRequest');

        const email = jwtToken.email.toLowerCase();

        const user = await env.USER.getByName(email).ensure(email);

        const [sub, ttl] = [nodeIdToStr({ kind: 'User', id: user.id }), 60 * 60 * 24 * 30];
        const userToken = await issueToken<UserToken>("UserToken", { sub, email }, { ttl });

        return {
          userToken,
          user: {
            id: sub,
            name: user.name,
          },
        };

      } catch (error) {
        return {
          status: 'error',
          userErrors: [{
            fieldName: 'enterRequestToken',
            messages: ["Invalid request token."],
          }],
        };
      }
    }),

  }),
};
