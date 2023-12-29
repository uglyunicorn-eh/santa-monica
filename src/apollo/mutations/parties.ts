import { ObjectId } from 'bson';
import lodash from 'lodash';
import { Db } from "mongodb";
import { ApolloContext } from 'src/apollo/context';

import { partyEntityToNode } from 'src/apollo/resolvers/party';
import { MutationPayload } from 'src/apollo/types';
import { PartyEntity, PartyMembershipEntity } from 'src/models';
import _ from 'src/utils/graphql/resolvable';
import NodeId from 'src/utils/nodeId';
import santaShuffle from 'src/utils/santaShuffle';
import { randomString } from 'src/utils/strings/random';

import { ClosePartyInput, CreatePartyInput, JoinPartyInput, LeavePartyInput } from "./types";
import { closePartyInputSchema, createPartyInputSchema, joinPartyInputSchema, leavePartyInputSchema } from "./validation";

import { baseUrl, sendgridTemplates } from 'src/config.json';

const generatePartySlug = async (db: Db) => {
  const PartyCollection = db.collection('Party');
  while (true) {
    const slug = randomString(5, 'QWERTYUIPASDFGHJKLZXCVBNMO');
    if (await PartyCollection.findOne({ slug })) {
      continue;
    }
    return slug;
  }
};

export default {
  parties: () => ({

    createParty: _(createPartyInputSchema)(async (input: CreatePartyInput, { db, userId, retrieveUser }: ApolloContext) => {
      const user = await retrieveUser();
      const entity = {
        _id: new ObjectId(),
        host: user._id,
        name: input.name,
        password: input.password || null,
        slug: await generatePartySlug(db),
        participantCount: 1,
      };
      await db.collection('Party').insertOne(entity);
      await db.collection('PartyMembership').insertOne({
        party: entity._id,
        member: user!._id,
        name: user!.name,
      });
      return {
        node: await partyEntityToNode(db, entity, userId),
      };
    }),

    joinParty: _(joinPartyInputSchema)(async ({ party, name, password }: JoinPartyInput, context: ApolloContext) => {
      const { db, userId, retrieveUser } = context;

      if (!userId) {
        return {
          status: 'error',
          userErrors: [{
            fieldName: null,
            messages: ['You must be logged in before joining the party.'],
          }],
        } as MutationPayload;
      }

      const partyNodeId = NodeId.fromString(party);
      if (partyNodeId.kind !== 'Party') {
        return {
          status: 'error',
          userErrors: [{
            fieldName: 'party',
            messages: ['Unknown input type. Must be Party.'],
          }],
        };
      }
      const partyEntity = await db.collection('Party').findOne({ _id: partyNodeId.id }) as (PartyEntity | null);
      if (!partyEntity) {
        return {
          status: 'error',
          userErrors: [{
            fieldName: 'party',
            messages: ['Party does not exist.'],
          }],
        };
      }

      if (await db.collection('PartyMembership').findOne({ party: partyEntity._id, member: userId })) {
        return {
          node: await partyEntityToNode(db, partyEntity, userId),
        };
      }

      if (partyEntity.isClosed) {
        return {
          status: 'error',
          userErrors: [{
            fieldName: 'party',
            messages: ['Party is already packed. Sorry, we cannot accept a new participant...'],
          }],
        };
      }

      if ((partyEntity.password || '').toUpperCase() !== (password || '').toUpperCase()) {
        return {
          status: 'error',
          userErrors: [{
            fieldName: 'password',
            messages: ["Hmm... Seems you've got a wrong secret phrase. Please try a different one or ask your friend for a hint."],
          }],
        };
      }

      const user = await retrieveUser();

      name = name || user!.name;
      if (!name) {
        return {
          status: 'error',
          userErrors: [{
            fieldName: 'name',
            messages: ["We we unable to get your name."],
          }],
        };
      }

      await db.collection('Party').updateOne({ _id: partyEntity._id }, { $inc: { participantCount: 1 } });
      await db.collection('PartyMembership').insertOne({
        party: partyEntity._id,
        member: user!._id,
        name,
      });
      await db.collection('User').updateOne({ _id: user!._id }, { $set: { name } });

      return {
        node: await partyEntityToNode(db, partyEntity, userId),
      };
    }),

    leaveParty: _(leavePartyInputSchema)(async ({ party }: LeavePartyInput, { db, userId }: ApolloContext) => {
      if (!userId) {
        return {
          status: 'error',
          userErrors: [{
            fieldName: null,
            messages: ['You must be logged in before leaving the party.'],
          }],
        } as MutationPayload;
      }

      const partyNodeId = NodeId.fromString(party);
      if (partyNodeId.kind !== 'Party') {
        return {
          userErrors: [{
            fieldName: 'party',
            messages: ['Unknown input type. Must be Party.'],
          }],
        };
      }
      const partyEntity = await db.collection('Party').findOne({ _id: partyNodeId.id }) as (PartyEntity | null);
      if (!partyEntity) {
        return {
          userErrors: [{
            fieldName: 'party',
            messages: ['Party does not exist.'],
          }],
        };
      }

      const membership = await db.collection('PartyMembership').findOne({ party: partyEntity._id, member: userId });
      if (!membership) {
        return {
          node: await partyEntityToNode(db, partyEntity, userId),
        };
      }

      if (partyEntity.isClosed) {
        return {
          userErrors: [{
            fieldName: 'party',
            messages: [
              'Party is already at that stage when you cannot really run away... Sorry but you have to get the gift',
            ],
          }],
        };
      }

      await db.collection('Party').updateOne({ _id: partyEntity._id }, { $inc: { participantCount: -1 } });
      await db.collection('PartyMembership').deleteMany({ party: partyEntity._id, member: userId });

      return {
        node: await partyEntityToNode(db, partyEntity, userId),
      };
    }),

    closeParty: _(closePartyInputSchema)(async ({ party }: ClosePartyInput, context: ApolloContext) => {
      const { db, userId, sendMail } = context;

      if (!userId) {
        return {
          status: 'error',
          userErrors: [{
            fieldName: null,
            messages: ['You must be logged in before leaving the party.'],
          }],
        } as MutationPayload;
      }

      const partyNodeId = NodeId.fromString(party);
      if (partyNodeId.kind !== 'Party') {
        return {
          userErrors: [{
            fieldName: 'party',
            messages: ['Unknown input type. Must be Party.'],
          }],
        };
      }
      let partyEntity = await db.collection('Party').findOne({ _id: partyNodeId.id }) as (PartyEntity | null);
      if (!partyEntity) {
        return {
          userErrors: [{
            fieldName: 'party',
            messages: ['Party does not exist.'],
          }],
        };
      }
      if (!partyEntity.host.equals(userId)) {
        return {
          userErrors: [{
            fieldName: 'party',
            messages: ['You must be the host to close the party.'],
          }],
        };
      }
      if (partyEntity.isClosed) {
        return {
          userErrors: [{
            fieldName: 'party',
            messages: ['Party is already closed.'],
          }],
        };
      }

      const members = (
        lodash
          .shuffle(
            await db.collection('PartyMembership').find({ party: partyEntity._id }).toArray()
          ) as PartyMembershipEntity[]
      );

      const results = santaShuffle(members, (a, b) => a.member.equals(b.member));
      results.forEach(async draw => {
        await db.collection('PartyMembership').updateOne({ _id: draw.src._id }, {
          $set: {
            target: {
              member: draw.target.member,
              name: draw.target.name,
            },
          },
        });
      });

      await db.collection('Party').updateOne({ _id: partyEntity._id }, { $set: { isClosed: true } });

      partyEntity = await db.collection('Party').findOne({ _id: partyNodeId.id }) as PartyEntity;

      const participants = members.map(m => m.member);
      let emails =
        (
          await db.collection('User')
            .find({ _id: { $in: participants } }, { projection: { email: true } })
            .toArray()
        ).map(({ email }) => email);

      const dynamicTemplateData = {
        party: {
          name: partyEntity.name,
          url: `${baseUrl}/p/${partyEntity.slug}/`,
        }
      };
      const to = emails.map(email => ({ to: email, dynamicTemplateData }));
      const res = await sendMail(sendgridTemplates.partyNotification, to);

      return {
        node: await partyEntityToNode(db, partyEntity, userId),
      };
    }),
  }),
};
