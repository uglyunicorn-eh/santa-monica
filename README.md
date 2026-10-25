![Welcome to Santa Monica](santa-monica.jpg)

# Anonymous Ded Morozes

This is back-end side of the Anonymous Ded Morozes

- [Front Yard](https://github.com/uglyunicorn-eh/santa-barbara)
- [Backyard](https://github.com/uglyunicorn-eh/santa-monica)

## Development

The API is a Cloudflare Worker (Hono + Apollo Server) with its data in Durable Objects: one `PartyDO` per party and one `UserDO` per user. Mail goes through Cloudflare Email Service. See [docs/MIGRATION_PLAN.md](docs/MIGRATION_PLAN.md) for the design.

One person can host at most 3 open parties at a time (`MAX_OPEN_HOSTED_PARTIES` in `src/apollo/mutations/parties.ts`). Parties joined as a guest don't count, and closing a party frees its slot right away.

Keeping Durable Object calls low:

- Each `UserDO` keeps a summary of the user's parties (name, host, protected, closed), so "my parties" is one call. Fields the summary doesn't have (participants, target, password) are loaded from the party only when a query asks for them, at most once per party per request.
- A party updates its members' summaries through its outbox. All of a user's queued changes go out in one `UserDO.apply` call, built from the party's current state when it's sent.
- The session token is checked once per request. Joining uses the session's email and doesn't read the profile.
- `test/unit/efficiency.test.ts` counts the calls each operation makes.

```bash
npm install
cp .dev.vars.example .dev.vars   # then set JWT_PRIVATE_KEY
npm run dev                      # http://localhost:8787, GraphQL at /graph
npm run typecheck
npm test                         # unit + integration
```

## Tests

- `npm run test:unit` tests every module directly (Durable Objects, resolvers, mutations, request auth, the HTTP layer, tokens, mail) and requires 100% coverage of lines, branches, functions and statements. The HTML report is written to `coverage/`.
- `npm run test:integration` runs every API scenario end to end through the Worker's real entry point in a local workerd: magic-link sign-in using the actual emailed link, rate limits, tokens, creating, joining, leaving and closing parties, the draw, notification emails and retries, and the HTTP surface. Email goes to a test mail sink (`test/integration/mail-sink.js`) instead of Cloudflare Email Service, so tests can read what was sent. Recipients starting with `fail+` simulate a failed delivery.
- `npm run smoke` runs read-only checks against a deployed Worker (`SMOKE_URL=https://...`).

## CI/CD

- **Pull requests** (`.github/workflows/preview.yml`): CI runs (typecheck, unit tests with 100% coverage, integration tests), then the PR is deployed to its own Worker, `gnomik-api-pr-<number>`, at `https://gnomik-api-pr-<number>.uglyunicorn.workers.dev`, smoke-tested, and the URL is posted on the PR. Each preview has its own empty Durable Objects, never production data. The preview Worker is deleted when the PR is closed.
- **Merges to main** (`.github/workflows/deploy.yml`): CI runs, then production is deployed to `https://api.gnomik.me` and smoke-tested.
- `.github/workflows/ci.yml` is the shared test job; it can also be run by hand.

GitHub secrets: `CLOUDFLARE_API_TOKEN` (a Cloudflare API token from the "Edit Cloudflare Workers" template, with access to the account and the gnomik.me zone), `CLOUDFLARE_ACCOUNT_ID`, and `PREVIEW_JWT_PRIVATE_KEY` (a P-256 private key used to sign preview tokens; previews have no frontend, so any key works).

## Logs and errors

Production logs (every `console.*` call plus Cloudflare's invocation logs) and request traces are kept in Workers Logs and exported to Better Stack, source `gnomik-api`, by Cloudflare's OpenTelemetry export. No SDK is involved: the destinations `betterstack-logs` and `betterstack-traces` are defined in the Cloudflare dashboard (Workers & Pages → Observability → Telemetry) and referenced by name in `wrangler.jsonc`. Previews keep their logs in Workers Logs only.

Every API action runs in its own span, `api.<action>` (for example `api.createParty`, `api.joinParty`, `api.party`), created with Workers' `tracing.enterSpan` (`src/utils/tracing.ts`). Spans record the action, the internal user id, the outcome (`api.status`, `api.user_error_fields`) and action details such as `party.code` or `auth.magic_link`, never emails or names. Durable Object calls made during an action show up as its child spans.

Unexpected errors return a 500 with an `errorId`; the same id is logged with the error (`message: "Unhandled error"`), so a reported error can be looked up in Better Stack.

## Deploying by hand

```bash
npx wrangler deploy --env=""                                  # production (api.gnomik.me)
npx wrangler deploy --env preview --name gnomik-api-pr-123    # a preview
```

Production secrets are set with `npx wrangler secret put JWT_PRIVATE_KEY`.

## Tokens

Magic-link and session tokens are ES256 JWTs (issuer `api.gnomik.me`) signed with `JWT_PRIVATE_KEY`, a P-256 private key in PKCS#8 PEM (real or escaped `\n` line breaks). The frontend ([santa-barbara](https://github.com/uglyunicorn-eh/santa-barbara)) verifies them in the browser with the matching public key, `publicKey` in its `src/config.json`, so the two must stay a pair: rotating the key means updating that file too.

To rotate:

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out jwt.pem
openssl pkey -in jwt.pem -pubout                     # public key for santa-barbara's src/config.json
npx wrangler secret put JWT_PRIVATE_KEY < jwt.pem
rm jwt.pem
```
