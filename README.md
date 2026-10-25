![Welcome to Santa Monica](santa-monica.jpg)

# Santa Monica

The API behind [Anonymous Ded Morozes](https://gnomik.me), a Secret Santa app: people sign in with a magic link,
host or join a party, and the host draws who gives a gift to whom. The web app is
[santa-barbara](https://github.com/uglyunicorn-eh/santa-barbara).

## How it works

- **A Cloudflare Worker** ([Hono](https://hono.dev)) serves the JSON API at `https://api.gnomik.me/v1`.
- **Durable Objects with SQLite storage** hold all data:
  - `PartyDO`, one per party, keyed by its code: the party, its members and the draw. Changes other objects need (members' party lists, draw emails) go through an outbox in the same transaction and are delivered with retries; an alarm erases deleted parties once they can no longer be restored.
  - `UserDO`, one per email address: the profile, a summary of the user's parties, the session token version, and the bookkeeping for repeated requests, used links and the per-address email cap. Every address has one, account or not.
- **Email** goes through Cloudflare Email Service (`send_email` binding), from `info@gnomik.me`.
- **Sessions** are ES256 JWTs signed with `JWT_PRIVATE_KEY`. The frontend verifies them in the browser with the matching public key.

```
src/
  index.ts          app: security headers, CORS, error handling; exports the Durable Objects
  api/              routes (auth, me, parties), valibot schemas, sessions, input reading, rate limits
  do/               PartyDO, UserDO and their types
  mail/             email templates and sending
  utils/            tokens, ids, the draw, email normalization, tracing, log refs
```

## API

JSON in, JSON out. A signed-in request sends `Authorization: Bearer <session token>`.

| Route | Session | Does |
|---|---|---|
| `POST /v1/auth/magic-link` `{email, party?}` | — | Emails a sign-in link (202) |
| `POST /v1/auth/session` `{token}` | link | Signs in with that link: `{userToken, user}` |
| `GET /v1/me` | yes | The signed-in user |
| `PATCH /v1/me` `{name}` | yes | Sets the profile name |
| `GET /v1/me/parties?first&after` | yes | My parties, newest first: `{items, hasMore, endCursor}` (`first` 1–100, default 10) |
| `POST /v1/me/email-change` `{email}` | yes | Emails a confirmation link to the new address, and a notice with a cancel link to the current one (202) |
| `POST /v1/me/email-change/confirm` `{token}` | link | Moves the account to the new address: `{userToken, user}` |
| `POST /v1/me/email-change/cancel` `{token}` | link | "This wasn't me": stops the change and signs out everywhere |
| `POST /v1/me/deletion` | yes | Emails a link that deletes the account (202) |
| `POST /v1/me/deletion/confirm` `{token}` | link | Deletes the account |
| `GET /v1/parties?code=` | optional | A party, as this person sees it |
| `POST /v1/parties` `{name, password?}` | yes | Creates a party (201) |
| `POST /v1/parties/join` `{code, name, password?}` | yes | Joins |
| `POST /v1/parties/leave` `{code}` | yes | Leaves |
| `POST /v1/parties/draw` `{code}` | yes | Draws (host only) |
| `POST /v1/parties/delete` `{code}` | yes | Deletes an open party (host only); restorable for 24 hours |
| `POST /v1/parties/restore` `{code}` | yes | Restores it (host only) |

- **Errors** always answer `{ "error": { "code", "message", "field" } }`: 400 `invalid` / `invalid_link`, 401 `unauthenticated`, 403 `forbidden`, 404 `not_found`, 409 `conflict` / `link_used` / `account_busy`, 429 `rate_limited`, 503 `unavailable` / `not_finished`, and 500 `internal` with an `errorId` that is also logged with the error. **401 only ever means the session is missing, invalid or revoked**: the frontend signs out on it.
- **Input and output are [valibot](https://valibot.dev) schemas** (`src/api/schemas.ts`). Bodies are strict objects of bounded, trimmed text fields (`src/api/limits.ts`; the web app's forms should use the same numbers); unknown fields and anything over a limit are refused by name. Responses are shaped from stored records by output schemas, so nothing else leaves the Worker.
- **Every write is safe to repeat.** Joining, leaving, drawing, deleting, restoring and renaming answer with the current state when already done. Routes that send email or create something take an `Idempotency-Key` header (16–100 letters, digits, `-`, `_`): a repeat within ten minutes gets the same answer without sending or creating again. Emailed links are single-use, but the request that used one can repeat with the same key and get the same outcome.
- **A party code never appears in a URL path.** Writes send it in the body; `GET /v1/parties` takes it as `?code=`, which Cloudflare's request logs leave out (`redact_query_string`).

## Security

**Sessions.** Session tokens last 30 days and carry the account's token version. Every signed-in route checks it, either in the Durable Object call the route makes anyway or with one read of the user (`session.verify()`). Changing the email, deleting the account and "This wasn't me" bump the version, which ends every session at once. `test/integration/revocation.test.ts` calls every route with a revoked token and fails if a new route is missing from it.

**Emailed links.** Sign-in links last 5 minutes; account links (email change, deletion, cancel) last an hour. Each works once. Account links carry the token version they were issued for, so any version bump voids every pending one: someone with a stolen session may have asked for several.

**Email addresses.** Accounts are keyed by the normalized address (`canonicalEmail` in `src/utils/email.ts`): lowercased, and for Gmail also without dots or a `+tag`, with `googlemail.com` read as `gmail.com`, since Gmail delivers all of those to one mailbox. Accounts that were saved under a different spelling move to the normalized one on their owner's next sign-in. Asking to move an account to an address that already has one answers like any other request, and that address gets a notice instead of a link, so the API never reveals which addresses have accounts.

**Limits.** A party code is the key to a party without a secret phrase, so codes are hard to guess and slow to try:

| What | Limit | Where |
|---|---|---|
| Party codes | 8 letters (about 2·10^11); older parties keep 5-letter codes | `src/api/schemas.ts` |
| Party lookups per IP | 60 a minute; 10 a minute for 5-letter codes (also joins and sign-in links to them) | `PARTY_LOOKUP_RATE_LIMIT_IP`, `LEGACY_CODE_LOOKUP_RATE_LIMIT_IP` |
| Joins per user | 10 a minute | `JOIN_RATE_LIMIT_USER` |
| Wrong secret phrases | 5 per person and 20 per party in 15 minutes; the right phrase always gets in | `src/do/PartyDO.ts` |
| Emails | 10 a minute per IP, 3 a minute per address, and exactly 6 an hour per address | `ENTER_RATE_LIMIT_*`, `src/api/rateLimit.ts` |
| Open parties per host | 3 | `src/api/routes/parties.ts` |
| Request body | 16 KB | `src/api/limits.ts` |

Cloudflare's rate limits are counted per location and approximately; the phrase and per-address email limits are counted exactly by the Durable Objects. The hourly email cap is a trade-off: someone who knows an address can use up its emails, but only for an hour.

**Privacy in logs.** Logs and traces never carry emails, names or party codes. They refer to a party by `party.ref`, a 12-hex-digit HMAC of its code keyed from `JWT_PRIVATE_KEY` (`src/utils/logRef.ts`), so a party's requests can be followed but its code can't be recovered.

**HTTP.** Only the origins in `ALLOWED_ORIGINS` (`wrangler.jsonc`) get CORS headers: `https://gnomik.me` and its Pages previews in production, plus `http://localhost:4321`–`4323` for previews. Responses carry HSTS, `X-Frame-Options`, `nosniff` and a no-referrer policy.

## Development

Requires Node.js 22.

```bash
npm install
cp .dev.vars.example .dev.vars   # then set JWT_PRIVATE_KEY
npm run dev                      # http://localhost:8787
npm run typecheck
npm test                         # unit + integration
```

To try the web app against a local API, run `npx wrangler dev --env preview` here: it allows `localhost:4321`–`4323` and writes the emails it sends to files listed in its output. Then start santa-barbara with `PUBLIC_API_ENDPOINT=http://localhost:8787` and the public key matching your `JWT_PRIVATE_KEY` in `PUBLIC_JWT_PUBLIC_KEY`.

## Tests

- `npm run test:unit` covers every module directly and requires 100% coverage of lines, branches, functions and statements (report in `coverage/`). It also pins how many Durable Object calls each route makes, and that lists and parties cost the same however much they hold (`test/unit/efficiency.test.ts`).
- `npm run test:integration` runs every flow end to end through the Worker's real entry point, following the links in the emails the way a person would. Email goes to a test mail sink (`test/integration/mail-sink.js`); recipients starting with `fail+` simulate a failed delivery.
- `npm run smoke` runs read-only checks against a deployed API (`SMOKE_URL=https://...`).

## Deployment

- **Pull requests** (`.github/workflows/preview.yml`): CI, then a [Worker Preview](https://developers.cloudflare.com/workers/previews/) `pr-<number>` of the `gnomik-api-preview` Worker at `https://pr-<number>-gnomik-api-preview.uglyunicorn.workers.dev`, with its own empty storage, smoke-tested and linked on the PR. It is deleted when the PR closes. Previews take their settings from the `previews` block of `env.preview` in `wrangler.jsonc`.
- **Merges to `main`** (`.github/workflows/deploy.yml`): CI, then production at `https://api.gnomik.me`, smoke-tested.
- Third-party actions are pinned to commit SHAs; Dependabot proposes updates weekly. `package.json` `overrides` pins `undici` and `zod` (from the Cloudflare toolchain) past known advisories; drop them once the toolchain depends on fixed versions.

GitHub secrets. Pull-request jobs run code from any branch, so they never see the production token:

| Secret | Where | Cloudflare permissions |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `production` environment (deploys from `main` only) | Individual Workers Editor on `gnomik-api`; Workers Routes Edit on the `gnomik.me` zone (every deploy re-applies the `api.gnomik.me` custom domain) |
| `CLOUDFLARE_PREVIEW_API_TOKEN` | `preview` environment | Individual Workers Editor on `gnomik-api-preview` |
| `CLOUDFLARE_ACCOUNT_ID` | repository | — |
| `PREVIEW_JWT_PRIVATE_KEY` | repository | the previews' signing key |

By hand:

```bash
npx wrangler deploy --env=""                                                   # production
npx wrangler preview --env preview --name pr-123 --secrets-file secrets.json  # a Preview (JWT_PRIVATE_KEY in secrets.json)
npx wrangler preview delete --env preview --name pr-123
npx wrangler secret put JWT_PRIVATE_KEY                                        # production signing key
```

**Rotating the signing key.** The frontend verifies tokens with the matching public key (`publicKey` in santa-barbara's `src/config.json`), so update both together. Rotating signs everyone out.

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out jwt.pem
openssl pkey -in jwt.pem -pubout                     # public key for santa-barbara's src/config.json
npx wrangler secret put JWT_PRIVATE_KEY < jwt.pem
rm jwt.pem
```

## Operations

Production logs (`console.*` and Cloudflare's request logs) and traces are kept in Workers Logs and exported to Better Stack (source `gnomik-api`) through the `betterstack-logs` and `betterstack-traces` destinations configured in the Cloudflare dashboard. Previews keep theirs in Workers Logs only.

Every route runs in a span named `api.<action>` (`api.createParty`, `api.joinParty`, `api.party`, …) with the action, the internal user id, the outcome (`api.status`, `api.error_code`) and details such as `party.ref`. Durable Object calls show up as child spans. An unexpected error returns a 500 with an `errorId`; search the logs for it (`message: "Unhandled error"`).
