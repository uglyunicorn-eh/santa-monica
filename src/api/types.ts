import { TokenPayload } from 'src/utils/jwt';

/** Emailed to sign in. Single-use (`jti`). */
export interface EnterRequestToken extends TokenPayload {
  /** The normalized address (`canonicalEmail`). */
  email: string;
  /** The address as typed, when it differs: an account made before addresses were normalized may be kept under it. */
  typed?: string;
  party?: string;
  /** Random id that makes the magic link single-use. */
  jti?: string;
}

/**
 * Emailed to confirm deleting the account. Single-use (`jti`), identifies the user by id and email, and works only
 * while the account's token version is still `ver`: cancelling an email change (or any version bump) voids it.
 */
export interface AccountDeletionToken extends TokenPayload {
  sub: string;
  email: string;
  jti: string;
  ver: number;
}

/** Emailed to the new address to confirm an email change. Single-use (`jti`), and only while the version is `ver`. */
export interface EmailChangeToken extends TokenPayload {
  sub: string;
  /** The current (old) email. */
  email: string;
  newEmail: string;
  jti: string;
  ver: number;
}

/**
 * Emailed to the current address with the notice about an email change ("This wasn't me"). Cancels the change whose
 * link has the same `jti`, and signs out everywhere, which voids every other pending account link too.
 */
export interface EmailChangeCancelToken extends TokenPayload {
  sub: string;
  /** The current email, where the account is kept. */
  email: string;
  jti: string;
}

export interface UserToken extends TokenPayload {
  sub: string;
  email: string;
  /** The user's token version when this token was issued. Tokens issued before versions existed have none. */
  ver?: number;
}
