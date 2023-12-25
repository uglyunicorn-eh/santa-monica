import { ObjectId } from "bson";

export type Entity = {
  _id: ObjectId;
}

export type PartyEntity = Entity & {
  host: ObjectId;
  name: string;
  password: string | null;
  slug: string;
  participantCount: number;
  isClosed?: boolean;
};

export type UserEntity = Entity & {
  name: string;
  picture: string;
  // profiles: IUserProfiles;
};

export type PartyMembershipEntity = Entity & {
  party: ObjectId;
  member: ObjectId;
  name: string;
  target?: {
    user: ObjectId;
    name: string;
  };
}
