import type { PartyDO } from 'src/do/PartyDO';
import type { StatsDO } from 'src/do/StatsDO';
import type { UserDO } from 'src/do/UserDO';

export interface Env {
  PARTY: DurableObjectNamespace<PartyDO>;
  USER: DurableObjectNamespace<UserDO>;
  /** The Party'o'meter: one instance, `getByName(STATS_NAME)`. */
  STATS: DurableObjectNamespace<StatsDO>;
  EMAIL: SendEmail;
  ENTER_RATE_LIMIT_IP: RateLimit;
  ENTER_RATE_LIMIT_EMAIL: RateLimit;
  /** Distinct party codes looked up, per client IP. */
  PARTY_LOOKUP_RATE_LIMIT_IP: RateLimit;
  /** Lookups and joins of old 5-letter party codes, per client IP: stricter, as they're far easier to guess. */
  LEGACY_CODE_LOOKUP_RATE_LIMIT_IP: RateLimit;
  /** Join attempts, per user. */
  JOIN_RATE_LIMIT_USER: RateLimit;
  /** Invite requests, per user. */
  INVITE_RATE_LIMIT_USER: RateLimit;
  /** Requested emails (sign-in and account links), all addresses together: a rough backstop for the sending quota. */
  MAIL_RATE_LIMIT_ALL: RateLimit;
  /** Party'o'meter WebSocket upgrades, per client IP. */
  STATS_WATCH_RATE_LIMIT_IP: RateLimit;
  PUBLIC_URL: string;
  /** The frontend that emailed links open: https://gnomik.me in production, a local one for previews. */
  FRONTEND_URL: string;
  /** Browser origins allowed to call the API (CORS): comma-separated, `https://*.domain` for subdomains. */
  ALLOWED_ORIGINS: string;
  /**
   * Who may get email: comma-separated addresses and `@domain` entries. Set for PR previews only, which are public;
   * unset means anyone (production).
   */
  EMAIL_ALLOWLIST?: string;
  /** How long public answers (signed-out party views, the stats) are kept in memory, in ms. Unset: 3 s for views, 10 s for the stats. Tests set 0. */
  PUBLIC_CACHE_MS?: string;
  /**
   * "true": new session tokens and live tickets carry the email sealed (`em`) instead of readable (`email`). Tokens
   * are read either way, so turn it on one release after the code that reads `em` is out (src/utils/tokenEmail.ts).
   */
  SEAL_TOKEN_EMAIL?: string;
  /**
   * "true": only session tokens bound to a browser's key count (src/utils/dpop.ts); unbound ones are refused. Turn on
   * 30 days after the app starts binding at sign-in, when every unbound token has expired.
   */
  REQUIRE_BOUND_SESSIONS?: string;
  /** P-256 private key (PKCS#8 PEM) for ES256 tokens. The frontend verifies tokens with the matching public key. */
  JWT_PRIVATE_KEY: string;
}
