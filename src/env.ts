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
  /** Join attempts, per user. */
  JOIN_RATE_LIMIT_USER: RateLimit;
  PUBLIC_URL: string;
  /** The frontend that emailed links open: https://gnomik.me in production, a local one for previews. */
  FRONTEND_URL: string;
  /** P-256 private key (PKCS#8 PEM) for ES256 tokens. The frontend verifies tokens with the matching public key. */
  JWT_PRIVATE_KEY: string;
}
