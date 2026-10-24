import type { PartyDO } from 'src/do/PartyDO';
import type { UserDO } from 'src/do/UserDO';

export interface Env {
  PARTY: DurableObjectNamespace<PartyDO>;
  USER: DurableObjectNamespace<UserDO>;
  EMAIL: SendEmail;
  ENTER_RATE_LIMIT_IP: RateLimit;
  ENTER_RATE_LIMIT_EMAIL: RateLimit;
  PUBLIC_URL: string;
  JWT_SECRET: string;
  ADMIN_SECRET?: string;
  SENTRY_DSN?: string;
}
