import { ApolloContext } from 'src/apollo/context';
import { viewParty } from 'src/apollo/resolvers/party';
import { EnterRequestToken } from 'src/apollo/types';
import { renderSignIn } from 'src/mail';
import _ from 'src/utils/graphql/resolvable';
import { annotate } from 'src/utils/tracing';

import { emailRateLimit } from './rateLimit';
import { issueSession } from './session';
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

    enterRequest: _(enterRequestInputSchema, 'enterRequest')(async (input: EnterRequestInput, context: ApolloContext) => {
      const { env, clientIp, sendMail, issueToken } = context;
      const email = input.email.toLowerCase();

      const rateLimited = await emailRateLimit(env, clientIp, email);
      annotate({ 'auth.rate_limited': rateLimited ?? false, 'party.code': input.party ?? undefined });
      if (rateLimited) {
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
        jti: crypto.randomUUID(),
        ...(input.party ? { party: input.party } : {})
      }
      const token = await issueToken<EnterRequestToken>("EnterRequest", tokenPayload, { ttl: 300 });

      try {
        await sendMail(email, renderSignIn({ magicLink: `${baseUrl}/enter/${token}`, assetsUrl: env.PUBLIC_URL }));
        annotate({ 'mail.sent': true });
      } catch (error) {
        annotate({ 'mail.sent': false });
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

    enter: _(enterInputSchema, 'enter')(async (input: EnterInput, context: ApolloContext) => {
      const { env, jwtVerify, issueToken } = context;

      const { enterRequestToken } = input;

      try {
        const { email: tokenEmail, jti, exp } = await jwtVerify<EnterRequestToken>(enterRequestToken, 'EnterRequest');
        if (!jti || !exp) {
          throw new Error('Magic-link token without an id or expiry.');
        }

        const email = tokenEmail.toLowerCase();

        const user = await env.USER.getByName(email).redeemMagicLink(email, jti, exp * 1000);
        annotate({ 'auth.magic_link': user ? 'redeemed' : 'already_used', 'user.id': user?.id });
        if (!user) {
          return {
            status: 'error',
            userErrors: [{
              fieldName: 'enterRequestToken',
              messages: ["This magic link has already been used. Please request a new one."],
            }],
          };
        }

        return await issueSession(issueToken, user);

      } catch (error) {
        annotate({ 'auth.magic_link': 'invalid' });
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
