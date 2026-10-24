export type UserRecord = {
  id: string;
  email: string;
  name: string;
  joined: number;
};

/** A user's copy of a party summary, enough to list their parties without asking each party. */
export type UserPartyRecord = {
  slug: string;
  name: string;
  createdAt: number;
  isHost: boolean;
  isProtected: boolean;
  isClosed: boolean;
};

/** A row of the user's party list. Rows stored before summaries existed have null flags until they are refreshed. */
export type UserPartyListItem = Omit<UserPartyRecord, 'isHost' | 'isProtected' | 'isClosed'> & {
  isHost: boolean | null;
  isProtected: boolean | null;
  isClosed: boolean | null;
};

/** Changes PartyDO sends to a UserDO. Each one is idempotent, so a batch can be retried as a whole. */
export type UserUpdate =
  | { type: 'addParty'; party: UserPartyRecord }
  | { type: 'removeParty'; slug: string }
  | { type: 'setName'; name: string };


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
