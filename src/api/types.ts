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

/**
 * Session tokens and live tickets name the user's email in one of two ways: `email`, readable by anyone holding the
 * token, or `em`, the email sealed so only the Worker can read it (src/utils/tokenEmail.ts). New tokens carry `em` once
 * `SEAL_TOKEN_EMAIL` is on; tokens issued before keep `email` until they expire.
 */
type TokenEmail = { email: string; em?: never } | { em: string; email?: never };

export type UserToken = TokenPayload & TokenEmail & {
  sub: string;
  /** Set when the session is bound to a browser's key: its thumbprint (src/utils/dpop.ts). */
  cnf?: { jkt: string };
  /** The user's token version when this token was issued. Tokens issued before versions existed have none. */
  ver?: number;
};

/**
 * A short-lived ticket for opening a live-updates WebSocket (`/v1/parties/live`, `/v1/me/live`): browsers can't send an
 * Authorization header on a WebSocket, so a signed-in request trades its session for one first. Valid for a minute.
 */
export type LiveTicket = TokenPayload & TokenEmail & {
  sub: string;
  ver?: number;
};
