import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const resolve = {
  alias: {
    src: path.resolve(import.meta.dirname, 'src'),
    'package.json': path.resolve(import.meta.dirname, 'package.json'),
  },
};

// Throwaway P-256 keys for signing tokens in tests. TEST_PUBLIC_KEY is what the frontend would hold.
const keyPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const otherKeyPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });

const bindings = {
  JWT_PRIVATE_KEY: keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  TEST_PUBLIC_KEY: keyPair.publicKey.export({ type: 'spki', format: 'pem' }) as string,
  TEST_OTHER_PRIVATE_KEY: otherKeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  PUBLIC_URL: 'https://api.test',
  FRONTEND_URL: 'https://gnomik.me',
  ALLOWED_ORIGINS: 'https://gnomik.me,https://*.santa-57a.pages.dev',
  // Public answers (signed-out party views, the stats) aren't cached in tests, so every request sees things as they are.
  // Tests of the caches turn them on.
  PUBLIC_CACHE_MS: '0',
  // Production requires bound sessions; most tests sign in without a key. Tests of bound sessions turn it on.
  REQUIRE_BOUND_SESSIONS: 'false',
};

export default defineConfig({
  resolve,
  test: {
    // The mail sink's simulated delivery failures (integration tests) cross the RPC boundary and are also reported
    // as unhandled by workerd. They are expected, everything else still fails the run.
    onUnhandledError: error => !String((error as Error | undefined)?.message).includes('simulated delivery failure'),
    // Coverage is collected for the unit project (npm run test:unit). Workers only support istanbul, not v8.
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      exclude: [
        'src/env.ts',              // types only
        'src/do/types.ts',         // types only
        'src/mail/templates/**',   // generated template strings, no logic
      ],
      reporter: ['text', 'html', 'json'],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
    projects: [
      {
        resolve,
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: { bindings },
          }),
        ],
        // Some tests drive a dozen requests through real Durable Objects, which can pass 5s on CI with coverage on.
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'], testTimeout: 20_000 },
      },
      {
        resolve,
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              bindings,
              // Replace the Email Service binding with a sink that records messages, so tests can read them.
              email: { send_email: [] },
              serviceBindings: { EMAIL: { name: 'mail-sink', entrypoint: 'MailSink' } },
              kvNamespaces: { TEST_MAILS: 'test-mails' },
              // The limit on all emails together is one bucket for every test: open it up, or the suite would hit it.
              ratelimits: { MAIL_RATE_LIMIT_ALL: { namespace_id: '1007', simple: { limit: 1_000_000, period: 60 } } },
              workers: [{
                name: 'mail-sink',
                modules: true,
                script: fs.readFileSync(path.resolve(import.meta.dirname, 'test/integration/mail-sink.js'), 'utf8'),
                kvNamespaces: { MAILS: 'test-mails' },
              }],
            },
          }),
        ],
        test: { name: 'integration', include: ['test/integration/**/*.test.ts'] },
      },
    ],
  },
});
