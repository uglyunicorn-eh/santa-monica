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
