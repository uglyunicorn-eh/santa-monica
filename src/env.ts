import type { PartyDO } from 'src/do/PartyDO';
import type { UserDO } from 'src/do/UserDO';

export interface Env {
  PARTY: DurableObjectNamespace<PartyDO>;
  USER: DurableObjectNamespace<UserDO>;
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
  /** P-256 private key (PKCS#8 PEM) for ES256 tokens. The frontend verifies tokens with the matching public key. */
  JWT_PRIVATE_KEY: string;
}
