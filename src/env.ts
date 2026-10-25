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
  /** RSA private key (PEM). The frontend verifies tokens with the matching public key. */
  JWT_PRIVATE_KEY: string;
}
