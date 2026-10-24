import path from 'node:path';

import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      src: path.resolve(__dirname, 'src'),
      'package.json': path.resolve(__dirname, 'package.json'),
    },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          JWT_SECRET: 'test-jwt-secret-that-is-long-enough',
          ADMIN_SECRET: 'test-admin-secret',
          PUBLIC_URL: 'https://api.test',
        },
      },
    }),
  ],
});
