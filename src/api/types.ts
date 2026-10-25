import { TokenPayload } from 'src/utils/jwt';

/** Emailed to sign in. Single-use (`jti`). */
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

/** The signed-in user, as the API returns them. */
export type UserJson = {
  id: string;
  name: string;
  email: string;
};
