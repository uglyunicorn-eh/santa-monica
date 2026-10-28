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
 * Emailed with a party invite: signs the invited address in and joins the party in one step (`POST /v1/auth/invite`).
 * Single-use (`jti`), like a magic link, but it lasts INVITE_LINK_TTL, since an invite can wait in an inbox for days.
 */
export interface PartyInviteToken extends TokenPayload {
  /** The invited address, normalized (`canonicalEmail`). */
  email: string;
  /** The party's code. */
  party: string;
  jti: string;
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

/** A session token. Like every token it's encrypted (src/utils/jwt.ts), so the email in it is only read by the Worker. */
export type UserToken = TokenPayload & {
  sub: string;
  email: string;
  /** Set when the session is bound to a browser's key: its thumbprint (src/utils/dpop.ts). */
  cnf?: { jkt: string };
  /** The user's token version when this token was issued. Tokens issued before versions existed have none. */
  ver?: number;
};

/**
 * A short-lived ticket for opening a live-updates WebSocket (`/v1/parties/live`, `/v1/me/live`): browsers can't send an
 * Authorization header on a WebSocket, so a signed-in request trades its session for one first. A ticket for a party's
 * socket carries the party's code (`party`), so the code never goes in the socket's URL.
 */
export type LiveTicket = TokenPayload & {
  sub: string;
  email: string;
  ver?: number;
  party?: string;
};
