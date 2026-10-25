![Welcome to Santa Monica](santa-monica.jpg)

# Anonymous Ded Morozes

This is back-end side of the Anonymous Ded Morozes

- [Front Yard](https://github.com/uglyunicorn-eh/santa-barbara)
- [Backyard](https://github.com/uglyunicorn-eh/santa-monica)

## Development

The API is a Cloudflare Worker (Hono) with its data in Durable Objects: one `PartyDO` per party and one `UserDO` per user. Mail goes through Cloudflare Email Service. See [docs/MIGRATION_PLAN.md](docs/MIGRATION_PLAN.md) for the design.

### API

Plain JSON routes under `/v1` (`src/api/`). A signed-in request sends `Authorization: Bearer <session token>`.

| Route | Session | Does |
|---|---|---|
| `POST /v1/auth/magic-link` `{email, party?}` | — | Emails a sign-in link (202) |
| `POST /v1/auth/session` `{token}` | — | Signs in with that link: `{userToken, user}` |
| `GET /v1/me` | yes | The signed-in user |
| `PATCH /v1/me` `{name}` | yes | Sets the profile name |
| `GET /v1/me/parties?first&after` | yes | My parties, newest first: `{items, hasMore, endCursor}` (`first` 1–100, default 10) |
| `POST /v1/me/email-change` `{email}` | yes | Emails a link to the new address, and a notice to the current one (202) |
| `POST /v1/me/email-change/confirm` `{token}` | link | Moves the account: `{userToken, user}` |
| `POST /v1/me/deletion` | yes | Emails a link that deletes the account (202) |
| `POST /v1/me/deletion/confirm` `{token}` | link | Deletes the account |
| `GET /v1/parties/:code` | optional | A party, as this person sees it |
| `POST /v1/parties` `{name, password?}` | yes | Creates a party (201) |
| `POST /v1/parties/:code/join` `{name, password?}` | yes | Joins |
| `POST /v1/parties/:code/leave` | yes | Leaves |
| `POST /v1/parties/:code/draw` | yes | Rolls the dice (host only) |
| `DELETE /v1/parties/:code` | yes | Deletes an open party (host only); restorable for a day |
| `POST /v1/parties/:code/restore` | yes | Restores it |

- **CORS**: only the origins in `ALLOWED_ORIGINS` (`wrangler.jsonc`) may call the API from a browser. Production allows `https://gnomik.me` and the Cloudflare Pages previews (`https://*.gnomik-me.pages.dev`; a `*` matches exactly one label); previews also allow `http://localhost:4321`–`4323`. Other origins get no CORS headers, so browsers keep the answers from them.
- **Errors** always answer `{ "error": { "code", "message", "field" } }` with a matching status: 400 `invalid` (with the `field`), 400 `invalid_link`, 401 `unauthenticated`, 403 `forbidden`, 404 `not_found`, 409 `conflict` / `link_used` / `account_busy`, 429 `rate_limited`, 503 `unavailable` / `not_finished`, and 500 `internal` with an `errorId` (the error itself is only logged). **401 only ever means the session is missing, invalid or revoked**: the frontend signs out on it, so a bad emailed link never does that.
- **Every input and output is a [valibot](https://valibot.dev) schema** (`src/api/schemas.ts`). Request bodies are strict objects of text fields, each trimmed and length-limited (names and phrases 100, emails 128 and normalized (see Email addresses below), tokens 2048, party codes uppercased and checked); unknown fields, non-text values and anything over a limit are refused by name. Query strings (`first`, `after`), path params (`:code`), the `Idempotency-Key` and `Authorization` headers, and the payload of every token the API verifies have schemas too. The body as a whole is capped at 16 KB (`src/api/limits.ts`, the same numbers as santa-barbara's `src/limits.ts`). Responses are shaped from stored records by output schemas, which also check them on the way out: anything that doesn't fit, or isn't part of the answer, never leaves the Worker.
- **Every signed-in route checks the session's token version**, so tokens revoked by an email change or an account deletion stop working everywhere. The token's signature is checked once per request with no DO call; then either the route's own DO call checks the session (`updateName`, `startHosting`, `listParties`, the party's join, `beginMailRequest`), or `session.verify()` reads the user once (party view, leave, draw, delete). A revoked token looking up a party sees what anyone sees. `test/integration/revocation.test.ts` calls every route with a revoked token, and fails if a route is added without a row there.

### Email addresses

Accounts are keyed by the normalized address (`canonicalEmail` in `src/utils/email.ts`): trimmed and lowercased, and for Gmail also without dots or a `+tag` before the `@`, with `googlemail.com` read as `gmail.com`. Gmail delivers every such spelling to the same mailbox, so `John.Doe+santa@googlemail.com` and `johndoe@gmail.com` are one account, share one per-address rate limit, and get their mail at `johndoe@gmail.com`. Other providers' addresses are only lowercased.

Accounts made before this are kept under the address as typed (lowercased), and the `UserDO`s can't be listed to move them up front. So they move on their owner's next sign-in: when the normalized address has no account and the typed one does, the account moves over the same way an email change moves it (`adoptTypedAccount` in `src/api/account.ts`), parties and all, and older session tokens stop working. Asking to change to an address whose account is still kept under the typed spelling answers that the address is taken.

### Idempotency

Every write is safe to repeat (a retry, a double click, a reload):

- **By state**: renaming, joining (already a member), leaving (not a member), drawing (already drawn: the same draw, no second email), deleting (already deleted) and restoring (not deleted, no slot held) answer with the current state.
- **With an `Idempotency-Key` header** (16–100 letters, digits, `-`, `_`), for the routes that send email or create something: a repeat within ten minutes answers the same without sending or creating again, and costs no rate limit. The same key with different details (another address, party name or party code) is a new request. A request that fails frees its key, so a real retry does the work. Signed-in requests are claimed in the user's `UserDO` in the call that checks the session; sign-in requests are looked up first, rate-limited, and only then claimed, so nobody can fill an address's storage for free.
- **Emailed links** stay single-use, but remember the (hashed) key of the request that used them: repeating that same request signs in again (sign-in, email change) or answers ok (deletion); anyone else gets "already used".

### Limits

A party code is the key to a party without a secret phrase, so codes are hard to guess and slow to try:

- New parties get 8-letter codes (about 2·10^11 possibilities); parties created before keep their 5-letter codes.
- Each client IP can look up 60 codes a minute (`PARTY_LOOKUP_RATE_LIMIT_IP`), and only 10 of the old 5-letter codes (`LEGACY_CODE_LOOKUP_RATE_LIMIT_IP`). The stricter limit also covers joining a 5-letter party and asking for a sign-in link to one.
- Each user can try to join 10 times a minute (`JOIN_RATE_LIMIT_USER`).
- After 5 wrong secret phrases for a party within 15 minutes, that person has to wait out the 15 minutes (`MAX_PHRASE_GUESSES` in `src/do/PartyDO.ts`). This one is counted by the party itself, so it holds everywhere; Cloudflare's rate limits are counted per location.
- After 20 wrong secret phrases for a party within 15 minutes from everyone together (`MAX_PARTY_PHRASE_GUESSES`), more wrong guesses are refused until the window passes, so many accounts can't share the guessing. The right phrase always gets in. Refused guesses aren't counted, so the window can't be kept open forever.

Email is limited per client IP and per address each minute (`ENTER_RATE_LIMIT_IP`, `ENTER_RATE_LIMIT_EMAIL`), but Cloudflare counts those per location and approximately. So each address also gets **at most 6 emails in any hour** (`EMAILS_PER_ADDRESS_PER_HOUR` in `src/api/rateLimit.ts`), counted exactly by that address's `UserDO` (`mail_sent`), whether or not it has an account:

- Sign-in links, account deletion links and email-change links all count, and share one count. Over the cap the request gets 429 "That's a lot of emails for this address. Please try again in an hour."
- The notice to the current address about an email change counts too, but never blocks the change.
- A repeat with the same `Idempotency-Key` isn't counted again. A request that fails (the email couldn't be sent, or the change was refused) gives its count back.
- Party draw notifications aren't counted: one per draw, started by the host.
- The trade-off: anyone who knows an address can use up its emails for an hour, so its owner can't get a sign-in link until then. A daily cap would make that lockout a day.

One person can host at most 3 open parties at a time (`MAX_OPEN_HOSTED_PARTIES` in `src/api/routes/parties.ts`). Parties joined as a guest don't count. Closing or deleting a party frees its slot right away. Hosts can't leave their own party. The check and a slot for the new party are taken in one `UserDO.startHosting` call, so parallel creates can't get past the limit.

The host can delete a party until its dice are rolled: it leaves every member's list but the host's and its link stops working. For 24 hours (`RESTORE_WINDOW_MS` in `src/do/PartyDO.ts`) the host can bring it back exactly as it was; restoring an open party needs a free slot. After that the party's alarm erases it, and its code is never reused.

### Durable Object calls

`test/unit/efficiency.test.ts` holds a call budget for every route (and fails for a route without one), and checks that lists and parties cost the same however much they hold:

| Route | `UserDO` | `PartyDO` |
|---|---|---|
| `POST /v1/auth/magic-link` | 1 (the email cap), or 2 with an `Idempotency-Key` | 0, or 1 with a party code |
| `POST /v1/auth/session`, `GET /v1/me`, `PATCH /v1/me`, `GET /v1/me/parties`, `POST /v1/me/deletion` | 1 | 0 |
| `POST /v1/me/email-change` | 2, or 3 for a Gmail address typed differently from its normalized form | 0 |
| `POST /v1/me/deletion/confirm` | 2 | 1 per party |
| `POST /v1/me/email-change/confirm` | 4 | 1 per party |
| `GET /v1/parties/:code` | 0 anonymous, 1 signed in (in parallel) | 1 |
| `POST /v1/parties` | 1 | 1 |
| `POST /v1/parties/:code/join` | 0 (the party checks the session itself) | 1 |
| `leave`, `draw`, `DELETE` | 1 | 1 |
| `restore` | 1 | 2 |

- Signing in with a Gmail address typed differently from its normalized form costs 2 more `UserDO` calls, to look for an account kept under the typed address; moving one, once, costs what an email change does.
- Each `UserDO` keeps a summary of the user's parties, so "my parties" is one call for any page size. Rows saved before summaries existed are filled in from their parties once.
- A party updates its members' summaries through its outbox. All of a user's queued changes go out in one `UserDO.apply` call, built from the party's current state when it's sent.

```bash
npm install
cp .dev.vars.example .dev.vars   # then set JWT_PRIVATE_KEY
npm run dev                      # http://localhost:8787, API under /v1
npm run typecheck
npm test                         # unit + integration
```

## Tests

- `npm run test:unit` tests every module directly (Durable Objects, routes, input validation, sessions, idempotency, the HTTP layer, tokens, mail) and requires 100% coverage of lines, branches, functions and statements. The HTML report is written to `coverage/`.
- `npm run test:integration` runs every API flow end to end through the Worker's real entry point in a local workerd: magic-link sign-in using the actual emailed link, rate limits, tokens and revocation on every route, creating, joining, leaving, drawing, deleting and restoring parties, account deletion and email change through their emailed links, repeated requests, input bounds, notification emails and retries, and the HTTP surface. Email goes to a test mail sink (`test/integration/mail-sink.js`) instead of Cloudflare Email Service, so tests can read what was sent. Recipients starting with `fail+` simulate a failed delivery.
- `npm run smoke` runs read-only checks against a deployed Worker (`SMOKE_URL=https://...`).

## CI/CD

- **Pull requests** (`.github/workflows/preview.yml`): CI runs (typecheck, unit tests with 100% coverage, integration tests), then the PR is deployed as a [Worker Preview](https://developers.cloudflare.com/workers/previews/), `pr-<number>`, of the fixed Worker `gnomik-api-preview`, at `https://pr-<number>-gnomik-api-preview.uglyunicorn.workers.dev`, smoke-tested, and the URL is posted on the PR. Each Preview has its own empty Durable Objects, never production data, and is deleted when the PR is closed. Previews take their settings only from the `previews` block of `env.preview` in `wrangler.jsonc`. `gnomik-api-preview` itself serves nothing; it was deployed once (`npx wrangler deploy --env preview`) so a token can be scoped to it. A Preview name answers some requests with error 1101 for a while after it is deleted, so a reopened PR may need a minute.
- **Merges to main** (`.github/workflows/deploy.yml`): CI runs, then production is deployed to `https://api.gnomik.me` and smoke-tested.
- `.github/workflows/ci.yml` is the shared test job; it can also be run by hand.
- Every third-party action is pinned to a commit SHA, with its version in a comment, so a moved or hijacked tag can't change what runs. Dependabot (`.github/dependabot.yml`) proposes updates weekly in one grouped PR, a week after each release.
- `package.json` `overrides` pins `undici` and `zod` (pulled in by the Cloudflare toolchain) to versions without known advisories. Drop an override once the packages that bring them in depend on a fixed version.

Emailed links point at `FRONTEND_URL` (`wrangler.jsonc`): `https://gnomik.me` in production, `http://localhost:4321` for previews, so a local frontend can follow links from a preview.

GitHub secrets. Pull-request jobs run code from any branch, so they never see the production token:

- `CLOUDFLARE_API_TOKEN`: a secret of the `production` environment, which only `main` can deploy to. An account API token with **Workers Scripts: Edit** on the `gnomik-api` Worker only (the custom domain already exists, so no zone access is needed).
- `CLOUDFLARE_PREVIEW_API_TOKEN` (repository): the same, on `gnomik-api-preview` only.
- `CLOUDFLARE_ACCOUNT_ID` (repository).
- `PREVIEW_JWT_PRIVATE_KEY` (repository): a P-256 private key used to sign preview tokens; a local frontend pointed at a preview needs its public key, see santa-barbara's README.

## Logs and errors

Production logs (every `console.*` call plus Cloudflare's invocation logs) and request traces are kept in Workers Logs and exported to Better Stack, source `gnomik-api`, by Cloudflare's OpenTelemetry export. No SDK is involved: the destinations `betterstack-logs` and `betterstack-traces` are defined in the Cloudflare dashboard (Workers & Pages → Observability → Telemetry) and referenced by name in `wrangler.jsonc`. Previews keep their logs in Workers Logs only.

Every API route runs in its own span, `api.<action>` (for example `api.createParty`, `api.joinParty`, `api.party`), created with Workers' `tracing.enterSpan` (`src/utils/tracing.ts`). Spans record the action, the internal user id, the outcome (`api.status`, `api.error_code`, `api.user_error_fields`) and action details such as `party.ref` or `auth.magic_link`, never emails, names or party codes. A party code lets anyone into a party without a secret phrase, so logs carry `party.ref` instead: the first 12 hex digits of an HMAC of the code (`src/utils/logRef.ts`), keyed by HKDF from `JWT_PRIVATE_KEY`. The same party always has the same ref, so its requests can be followed in the logs, but the code can't be worked out from it. Durable Object calls made during an action show up as its child spans.

Unexpected errors return a 500 with an `errorId`; the same id is logged with the error (`message: "Unhandled error"`), so a reported error can be looked up in Better Stack.

## Deploying by hand

```bash
npx wrangler deploy --env=""                                                # production (api.gnomik.me)
npx wrangler preview --env preview --name pr-123 --secrets-file secrets.json   # a Preview (JWT_PRIVATE_KEY in secrets.json)
npx wrangler preview delete --env preview --name pr-123
```

Production secrets are set with `npx wrangler secret put JWT_PRIVATE_KEY`.

## Tokens

Session tokens carry the user's token version (`ver`). `UserDO.tombstone()` deletes an account: its record reads as missing, late updates from parties are ignored, and its version goes up, so every token issued before is refused on every signed-in route. Tokens without `ver` (issued before versions existed) count as version 0. The next sign-in with that email starts a new account.

Deleting an account and changing its email go through a link mailed to the user (`AccountDeletion` and `EmailChange` tokens, single-use, one hour):

- **Deleting** (`POST /v1/me/deletion` → `<FRONTEND_URL>/profile/delete/<token>` → `POST /v1/me/deletion/confirm`): every party on the user's list is told once (`PartyDO.forgetMember`). An open party they host is erased at once, whoever joined (even one they had deleted): it is gone right away, its code is never handed out again, and its members' lists are updated through the outbox. Open parties they joined are left. In drawn parties their membership is anonymized (new id, no email; the names stay so the draw still works). Then the `UserDO` is tombstoned.
- **While either runs**, the account is held (up to a minute): it reads as missing, can't join or create parties, and can't start another change. If a party can't be reached, what can be undone is undone and the link works again.
- **Changing the email** (`POST /v1/me/email-change` → `<FRONTEND_URL>/profile/email/<token>` to the new address, plus a notice to the old one → `POST /v1/me/email-change/confirm`): open parties move the membership and their queued updates to the new email (`PartyDO.changeMemberEmail`). Then the account is copied to the new address's `UserDO` (same id, token version + 1) and the old one is tombstoned. Drawn parties keep the old email; the user still sees them, since membership goes by user id. The confirm returns a session token for the new address.

Magic-link and session tokens are ES256 JWTs (issuer `api.gnomik.me`) signed with `JWT_PRIVATE_KEY`, a P-256 private key in PKCS#8 PEM (real or escaped `\n` line breaks). The frontend ([santa-barbara](https://github.com/uglyunicorn-eh/santa-barbara)) verifies them in the browser with the matching public key, `publicKey` in its `src/config.json`, so the two must stay a pair: rotating the key means updating that file too.

To rotate:

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out jwt.pem
openssl pkey -in jwt.pem -pubout                     # public key for santa-barbara's src/config.json
npx wrangler secret put JWT_PRIVATE_KEY < jwt.pem
rm jwt.pem
```
