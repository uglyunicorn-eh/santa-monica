![Welcome to Santa Monica](santa-monica.jpg)

# Anonymous Ded Morozes

This is back-end side of the Anonymous Ded Morozes

- [Front Yard](https://github.com/uglyunicorn-eh/santa-barbara)
- [Backyard](https://github.com/uglyunicorn-eh/santa-monica)

## Development

The API is a Cloudflare Worker (Hono + Apollo Server) with its data in Durable Objects: one `PartyDO` per party and one `UserDO` per user. Mail goes through Cloudflare Email Service. See [docs/MIGRATION_PLAN.md](docs/MIGRATION_PLAN.md) for the design.

```bash
npm install
cp .dev.vars.example .dev.vars   # then set JWT_SECRET (and ADMIN_SECRET for imports)
npm run dev                      # http://localhost:8787, GraphQL at /graph
npm run typecheck
npm test                         # unit + integration
```

## Tests

- `npm run test:unit` tests every module directly (Durable Objects, resolvers, mutations, middleware, the HTTP layer, tokens, mail) and requires 100% coverage of lines, branches, functions and statements. The HTML report is written to `coverage/`.
- `npm run test:integration` runs every API scenario end to end through the Worker's real entry point in a local workerd: magic-link sign-in using the actual emailed link, rate limits, tokens, creating, joining, leaving and closing parties, the draw, notification emails and retries, the HTTP surface, and the Mongo import. Email goes to a test mail sink (`test/integration/mail-sink.js`) instead of Cloudflare Email Service, so tests can read what was sent. Recipients starting with `fail+` simulate a failed delivery.
- `npm run smoke` runs read-only checks against a deployed Worker (`SMOKE_URL=https://...`).

CI (`.github/workflows/ci.yml`) runs the typecheck and both suites on every push and pull request. The deploy workflow runs CI first, deploys with Wrangler, then runs the smoke test against the deployment (set the `SMOKE_URL` repository variable to override the URL, e.g. after cutover).

## Deploy

Deploy with `npm run deploy`, or run the "Deploy to Cloudflare" workflow (needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets). Production secrets are set with `npx wrangler secret put JWT_SECRET` (and `SENTRY_DSN`).
