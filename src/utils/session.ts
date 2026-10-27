/**
 * The DPoP proof a bound session came with (src/utils/dpop.ts), so the user's object can let each proof work only
 * once: `jti` is the proof's id, `request` names the request it came with (one request may check its session more
 * than once), and `until` is when the proof stops being accepted anyway, in ms.
 */
export type SessionProof = { jti: string; request: string; until: number };

/** What a session token says about its user: the account id and the token version it was issued with. */
export type Session = {
  userId: string;
  /** Missing on tokens issued before versions existed; they count as version 0. */
  tokenVersion?: number;
  /** Set for a bound token: the proof it came with. */
  proof?: SessionProof;
};

/**
 * Whether a session token still belongs to this user record. It doesn't when the account was deleted (no record, or a
 * new account under the same email with another id) or its tokens were revoked (the record's version moved on).
 */
export function sessionMatches(user: { id: string; tokenVersion: number } | null | undefined, session: Session): boolean {
  return Boolean(user && user.id === session.userId && user.tokenVersion === (session.tokenVersion ?? 0));
}
