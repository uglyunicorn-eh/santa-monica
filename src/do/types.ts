export type UserRecord = {
  id: string;
  email: string;
  name: string;
  joined: number;
};

export type UserPartyRecord = {
  slug: string;
  name: string;
  createdAt: number;
};

export type UserSnapshot = UserRecord & {
  parties: UserPartyRecord[];
};

export type Member = {
  id: string;
  email: string | null;
  name: string;
};

export type PartyView = {
  id: string;
  slug: string;
  name: string;
  password: string | null;
  isProtected: boolean;
  isHost: boolean;
  isJoined: boolean;
  isClosed: boolean;
  participantCount: number | null;
  participants: string[] | null;
  target: { id: string; name: string } | null;
};

export type PartyUserError = {
  fieldName: string | null;
  message: string;
};

export type PartyResult =
  | { ok: true; view: PartyView }
  | { ok: false; error: PartyUserError };

export type CreatePartyInput = {
  name: string;
  password: string | null;
  host: Member;
};

export type MemberSnapshot = Member & {
  targetId: string | null;
  targetName: string | null;
  joinedAt: number;
};

export type PartySnapshot = {
  id: string;
  slug: string;
  name: string;
  password: string | null;
  hostId: string;
  isClosed: boolean;
  createdAt: number;
  members: MemberSnapshot[];
};

export type ImportSnapshot = {
  users: UserSnapshot[];
  parties: PartySnapshot[];
};
