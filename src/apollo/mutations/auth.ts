import { ObjectId } from 'mongodb';
import { ApolloContext } from 'src/apollo/context';
import _ from 'src/utils/graphql/resolvable';

import { EnterInput, EnterRequestInput } from './types';
import { enterInputSchema, enterRequestInputSchema } from './validation';

import { PartyEntity, UserEntity } from "src/models";
import { nodeIdToStr } from 'src/utils/strings/nodeId';
import { EnterRequestToken, UserToken } from 'src/apollo/types';

import { baseUrl, sendgridTemplates } from 'src/config.json';

export default {
  auth: () => ({

    enterRequest: _(enterRequestInputSchema)(async (input: EnterRequestInput, context: ApolloContext) => {
      const { db, sendMail, issueToken } = context;

      let party: PartyEntity | undefined = undefined;

      if (input.party) {
        party = await db.collection('Party').findOne({ slug: input.party }) as PartyEntity;
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
        email: input.email,
        ...(party ? { party: party.slug } : {})
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

      return {};
    }),

    enter: _(enterInputSchema)(async (input: EnterInput, context: ApolloContext) => {
      const { jwtVerify, issueToken, db } = context;
      const User = db.collection('User');

      const { enterRequestToken } = input;

      try {
        const jwtToken = await jwtVerify<EnterRequestToken>(enterRequestToken);

        const email = jwtToken.email.toLowerCase();

        let user = await User.findOne({ email }) as UserEntity;

        if (user === null) {
          user = {
            _id: new ObjectId(),
            name: "",
            email,
            joined: new Date(),
          };
          await User.insertOne(user);
        }

        const [sub, ttl] = [nodeIdToStr({ kind: 'User', id: user._id }), 60 * 60 * 24 * 30]
        const userToken = await issueToken<UserToken>("UserToken", { sub }, { ttl });

        return {
          userToken,
          user: {
            id: nodeIdToStr({ kind: 'User', id: user._id }),
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
