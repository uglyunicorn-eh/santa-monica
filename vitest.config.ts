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

const bindings = {
  JWT_SECRET: 'test-jwt-secret-that-is-long-enough',
  ADMIN_SECRET: 'test-admin-secret',
  PUBLIC_URL: 'https://api.test',
};

export default defineConfig({
  resolve,
  test: {
    // The mail sink's simulated delivery failures (integration tests) cross the RPC boundary and are also reported
    // as unhandled by workerd. They are expected, everything else still fails the run.
    onUnhandledError: error => !String((error as Error | undefined)?.message).includes('simulated delivery failure'),
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
