import { TokenPayload } from "src/utils/jwt";

export type Node = {
  id: string;
};

export type Party = Node & {
  code: string;
  name: string;
  password: string | null;
  isJoined: boolean;
  isHost: boolean;
  isProtected: boolean;
  isClosed: boolean;
  deletedAt: string | null;
  restorableUntil: string | null;
  participantCount: number | null;
  participants: string[] | null;
  target: User | null;
};

export type User = Node & {
  name: string;
  /** Only for the signed-in user. */
  email?: string | null;
};

export type UserError = {
  fieldName: string | null;
  messages: string[];
};

export type MutationPayload = {
  status: 'ok' | 'error';
  userErrors: UserError[] | null;
};

export interface NodeMutationPayload<T extends Node = Node> extends MutationPayload {
  node: T | null;
}

export type MutationInput<T> = {
  input: T;
};

export interface EnterRequestToken extends TokenPayload {
  email: string;
  party?: string;
  /** Random id that makes the magic link single-use. */
  jti?: string;
}

/** Emailed to confirm deleting the account. Single-use (`jti`), identifies the user by id and email. */
export interface AccountDeletionToken extends TokenPayload {
  sub: string;
  email: string;
  jti: string;
}

/** Emailed to the new address to confirm an email change. Single-use (`jti`). */
export interface EmailChangeToken extends TokenPayload {
  sub: string;
  /** The current (old) email. */
  email: string;
  newEmail: string;
  jti: string;
}

export interface UserToken extends TokenPayload {
  sub: string;
  email: string;
  /** The user's token version when this token was issued. Tokens issued before versions existed have none. */
  ver?: number;
}
