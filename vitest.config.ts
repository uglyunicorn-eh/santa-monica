import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const resolve = {
  alias: {
    src: path.resolve(__dirname, 'src'),
    'package.json': path.resolve(__dirname, 'package.json'),
  },
};

// Throwaway P-256 keys for signing tokens in tests. TEST_PUBLIC_KEY is what the frontend would hold.
const keyPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const otherKeyPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });

const bindings = {
  JWT_PRIVATE_KEY: keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  TEST_PUBLIC_KEY: keyPair.publicKey.export({ type: 'spki', format: 'pem' }) as string,
  TEST_OTHER_PRIVATE_KEY: otherKeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  ADMIN_SECRET: 'test-admin-secret',
  PUBLIC_URL: 'https://api.test',
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
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'] },
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
              workers: [{
                name: 'mail-sink',
                modules: true,
                script: fs.readFileSync(path.resolve(__dirname, 'test/integration/mail-sink.js'), 'utf8'),
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
