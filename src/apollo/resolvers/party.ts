import { Db, ObjectId } from "mongodb";
import { ApolloContext } from "src/apollo/context";
import { Party, User } from "src/apollo/types";
import { PartyEntity, PartyMembershipEntity, UserEntity } from "src/models";
import { nodeIdToStr } from "src/utils/strings/nodeId";

type PartyArgs = {
  code: string;
}

type PartiesArgs = {
  first: number;
}

export async function partyEntityToNode(db: Db, party?: PartyEntity, user?: UserEntity): Promise<Party | null> {
  if (!party) {
    return null;
  }
  const isHost = Boolean(user && `${user._id}` === `${party.host}`);
  const isClosed = Boolean(party.isClosed);
  const membership = user
    ? await db.collection('PartyMembership').findOne({ party: party._id, member: user._id }) as PartyMembershipEntity
    : null;
  const isJoined = Boolean(membership);
  let participants: string[] | null = null;
  if (user && membership) {
    let qs: any = db.collection('PartyMembership');
    if (!isHost) {
      qs = qs.find({
        party: party._id,
        member: { $ne: user._id },
      }).limit(3);
    } else {
      qs = qs.find({
        party: party._id,
      }).sort({ name: 1 });
    }
    participants = (await qs.toArray()).map((doc: PartyMembershipEntity) => doc.name);
  }
  let target: User | null = null;
  if (isClosed && membership && membership.target) {
    target = {
      id: nodeIdToStr({ kind: 'User', id: membership.target.user }),
      name: membership.target.name,
    };
  }
  return {
    id: nodeIdToStr({ kind: 'Party', id: party._id }),
    name: party.name,
    code: party.slug,
    isJoined,
    isHost,
    password: isHost ? party.password : null,
    isProtected: Boolean(party.password),
    participantCount: isJoined ? party.participantCount : null,
    participants,
    isClosed,
    target,
  } as Party;
}

export default {
  party: async (root: any, { code }: PartyArgs, { user, db }: ApolloContext) => {
    const theCode = code.toUpperCase();
    const party = await db.collection('Party').findOne({ slug: theCode }) as PartyEntity;
    return await partyEntityToNode(db, party, user);
  },

  parties: async (root: any, { first }: PartiesArgs, { user, db }: ApolloContext, info: any) => {
    // const memberships = await db.collection('PartyMembership').find({ member: user!._id }).limit(first).toArray();
    // const partyIds: ObjectId[] = memberships.map(({ party }) => party);
    // const parties = await db.collection('Party').find({ _id: { $in: partyIds } }).toArray();
    // return parties.map(async partyEntity => await partyEntityToNode(db, partyEntity as PartyEntity, user));

    const parties = await db.collection('Party').find().toArray();
    return parties.map(async partyEntity => await partyEntityToNode(db, partyEntity as PartyEntity, user));
  },
};
