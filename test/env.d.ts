import type { Env as AppEnv } from 'src/env';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      /** Test-only keys, generated in vitest.config.ts. */
      TEST_PUBLIC_KEY: string;
      TEST_OTHER_PRIVATE_KEY: string;
    }
  }
}
