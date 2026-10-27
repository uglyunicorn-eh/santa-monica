[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/banner2-direct.svg)](https://savelife.in.ua/en/)

> [!IMPORTANT]
> Russia is waging a full-scale war against Ukraine. Please help Ukraine's defenders: donate to [Come Back Alive](https://savelife.in.ua/en/).
>
> **Be brave like Ukraine** 🇺🇦 [Stand with Ukraine](https://savelife.in.ua/en/)

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
  - `StatsDO`, just one: the Party'o'meter, how many parties have rolled their dice, ever. Viewers watch it over a WebSocket.
- **Email** goes through Cloudflare Email Service (`send_email` binding), from `info@gnomik.me`.
- **Sessions** are ES256 JWTs signed with `JWT_PRIVATE_KEY`. The frontend verifies them in the browser with the matching public key. A session can be bound to a key the browser keeps (DPoP, see Security).

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
| `POST /v1/auth/session` `{token, key?}` | link | Signs in with that link: `{userToken, user}`. With `key`, the session is bound to it |
| `GET /v1/me` | yes | The signed-in user |
| `PATCH /v1/me` `{name}` | yes | Sets the profile name |
| `GET /v1/me/parties?first&after` | yes | My parties, newest first: `{items, hasMore, endCursor}` (`first` 1–100, default 10) |
| `POST /v1/me/email-change` `{email}` | yes | Emails a confirmation link to the new address, and a notice with a cancel link to the current one (202) |
| `POST /v1/me/email-change/confirm` `{token, key?}` | link | Moves the account to the new address: `{userToken, user}`. With `key`, the session is bound to it |
| `POST /v1/me/email-change/cancel` `{token}` | link | "This wasn't me": stops the change and signs out everywhere |
| `POST /v1/me/sign-out` | yes | Signs out every device, this one included |
| `POST /v1/me/deletion` | yes | Emails a link that deletes the account (202) |
| `POST /v1/me/deletion/confirm` `{token}` | link | Deletes the account |
| `POST /v1/parties/lookup` `{code}` | optional | A party, as this person sees it |
| `GET /v1/parties?code=` | optional | The same, with the code in the URL. Being replaced by `POST /v1/parties/lookup` |
| `POST /v1/parties` `{name, password?}` | yes | Creates a party (201) |
| `POST /v1/parties/join` `{code, name, password?}` | yes | Joins |
| `POST /v1/parties/leave` `{code}` | yes | Leaves |
| `POST /v1/parties/draw` `{code}` | yes | Draws (host only) |
| `POST /v1/parties/invite` `{code, emails}` | yes | Emails invites to up to 10 addresses (host only, open parties): `{invited, alreadyInvited, alreadyJoined, invitesLeft}` |
| `POST /v1/parties/delete` `{code}` | yes | Deletes an open party (host only); restorable for 24 hours |
| `POST /v1/parties/restore` `{code}` | yes | Restores it (host only) |
| `GET /v1/stats` | — | The Party'o'meter: `{rolled}`, how many parties have rolled their dice |
| `GET /v1/stats/live` | — | The same as a WebSocket: `{"type":"stats","rolled":N}` on connect and after every roll |

- **Errors** always answer `{ "error": { "code", "message", "field" } }`: 400 `invalid` / `invalid_link`, 401 `unauthenticated`, 403 `forbidden`, 404 `not_found`, 409 `conflict` / `link_used` / `account_busy`, 429 `rate_limited`, 503 `unavailable` / `not_finished`, and 500 `internal` with an `errorId` that is also logged with the error. **401 only ever means the session is missing, invalid or revoked**: the frontend signs out on it.
- **Input and output are [valibot](https://valibot.dev) schemas** (`src/api/schemas.ts`). Bodies are strict objects of bounded, trimmed text fields (`src/api/limits.ts`; the web app's forms should use the same numbers); unknown fields and anything over a limit are refused by name. Responses are shaped from stored records by output schemas, so nothing else leaves the Worker.
- **Every write is safe to repeat.** Joining, leaving, drawing, deleting, restoring and renaming answer with the current state when already done; an invite skips the addresses already invited that day. Routes that send email or create something take an `Idempotency-Key` header (16–100 letters, digits, `-`, `_`): a repeat within ten minutes gets the same answer without sending or creating again. Emailed links are single-use, but the request that used one can repeat with the same key and get the same outcome.
- **A party code never appears in a URL path.** Writes and `POST /v1/parties/lookup` send it in the body. The older `GET /v1/parties` takes it as `?code=`, which Cloudflare's request logs leave out (`redact_query_string`), but browser history and proxy logs don't.

## Security

**Sessions.** Session tokens last 30 days and carry the account's token version. Every signed-in route checks it, either in the Durable Object call the route makes anyway or with one read of the user (`session.verify()`). Signing out everywhere, changing the email, deleting the account and "This wasn't me" bump the version, which ends every session at once. `test/integration/revocation.test.ts` calls every route with a revoked token and fails if a new route is missing from it.

**Bound sessions (DPoP, RFC 9449).** At sign-in the app can send a public key (a P-256 JWK with only `kty`, `crv`, `x`, `y`) from a key pair it can't export. The session token then carries the key's thumbprint (`cnf.jkt`), and every request with it needs a `DPoP` proof signed by that key, for that method, URL and token, made within a minute (`src/utils/dpop.ts`). On routes that change something, each proof works for one request only: the user's object records its `jti` in the session check every signed-in route already makes (`UserDO.holds`), at no extra call. Reads (GET routes and the lookups) check the proof but don't record it, so they write nothing. So a token copied out of a HAR file, a log or a header is useless on its own; with the proof that came with it, it can at most re-send that one read, to that URL, within its minute. A missing or wrong proof is a 401. A proof that's only off on its clock is a 400 with the Worker's time in `DPoP-Time`, so the app can correct its clock and retry instead of signing out. `REQUIRE_BOUND_SESSIONS` makes bound tokens the only ones that count.

**The email in tokens.** Session tokens and live tickets name the user's email, which anyone holding one could read. With `SEAL_TOKEN_EMAIL` on, they carry it sealed instead (`em`: AES-256-GCM with a key derived from `JWT_PRIVATE_KEY`, `src/utils/tokenEmail.ts`), so only the Worker can read it. Both kinds are read either way.

**Emailed links.** Sign-in links last 5 minutes; account links (email change, deletion, cancel) last an hour. Each works once. Account links carry the token version they were issued for, so any version bump voids every pending one: someone with a stolen session may have asked for several.

**Email addresses.** Accounts are keyed by the normalized address (`canonicalEmail` in `src/utils/email.ts`): lowercased, and for Gmail also without a `+tag`, with `googlemail.com` read as `gmail.com`, since Gmail delivers those to one mailbox. Dots are kept, so the address reads the way its owner typed it. Accounts saved under an older spelling (as typed, or a Gmail address without its dots) move to the normalized one on their owner's next sign-in. Asking to move an account to an address that already has one answers like any other request, and that address gets a notice instead of a link, so the API never reveals which addresses have accounts.

**Limits.** A party code is the key to a party without a secret phrase, so codes are hard to guess and slow to try:

| What | Limit | Where |
|---|---|---|
| Party codes | 8 letters (about 2·10^11); older parties keep 5-letter codes | `src/api/schemas.ts` |
| Party codes tried per IP | 60 a minute; 10 a minute for 5-letter codes. Every route that takes a code counts (lookups and all party writes), since each one tells whether the party exists; so do sign-in links to 5-letter codes | `PARTY_LOOKUP_RATE_LIMIT_IP`, `LEGACY_CODE_LOOKUP_RATE_LIMIT_IP` |
| Joins per user | 10 a minute | `JOIN_RATE_LIMIT_USER` |
| Wrong secret phrases | 5 per person and 20 per party in 15 minutes; the right phrase always gets in | `src/do/PartyDO.ts` |
| Emails | 10 a minute per IP, 3 a minute per address, and exactly 6 an hour per address (invites included) | `ENTER_RATE_LIMIT_*`, `src/api/rateLimit.ts` |
| Emails, all addresses together | 60 a minute, roughly: a backstop so a spike or a spam run can't use up the sending quota. Taken right before an email is sent (requested emails and party invites), so refused requests don't use it up. Over it, a requested email is a 429 and an invite waits for the outbox's next try | `MAIL_RATE_LIMIT_ALL` |
| Party'o'meter sockets | 30 a minute per IP | `STATS_WATCH_RATE_LIMIT_IP` |
| Invites | Up to 10 addresses a request and 3 requests a minute per host; 50 per party in all; one per address per party a day | `INVITE_RATE_LIMIT_USER`, `MAX_PARTY_INVITES` in `src/do/PartyDO.ts` |
| Open parties per host | 3 | `src/api/routes/parties.ts` |
| People per party | 100, host included; a join after that is refused with "This party is full" | `MAX_PARTY_MEMBERS` in `src/do/PartyDO.ts` |
| New parties per person | 10 a day, deleted ones included (restoring one doesn't count) | `MAX_NEW_PARTIES_PER_DAY`, counted by `UserDO` |
| Names | 32 characters for a person (profile and join name), 48 for a party; names saved before keep their length | `src/api/limits.ts` |
| Request body | 16 KB | `src/api/limits.ts` |

Cloudflare's rate limits are counted per location and approximately; the phrase, new-party and per-address email limits are counted exactly by the Durable Objects. The hourly email cap is a trade-off: someone who knows an address can use up its emails, but only for an hour.

**The draw** is uniformly random over every way to give everyone one target other than themselves (`src/utils/santaShuffle.ts`, with a cryptographic random source), so nobody can guess who drew whom better than by chance.

**What we keep.** The profile (email, name), the parties you're in, and for each party its members. A party lets go of its members' emails once it's drawn and the draw's emails have gone out; after that it knows members by id. Invited addresses are kept for a day only, to skip repeat invites. A deleted account keeps neither its name nor its email. Expired link and request records are deleted when the object starts. Each object does this itself; `scripts/data.ts tidy` does it for objects nobody opens any more. Cloudflare keeps 30 days of point-in-time history, so deleted data stays there that long. Stored data isn't encrypted by the app: Cloudflare encrypts it on disk, and anyone who could read it otherwise (Data Studio needs Editor access to the Worker) could also deploy code that reads any key. Keeping less is what protects it.

**Signed-out party views** are kept for 3 seconds in the Worker's memory (never in a cache), so a party link that goes viral doesn't send every visitor to the same Durable Object. A write through the Worker (join, leave, draw, invite, delete, restore, or an account deletion that erases the party) forgets the view in that isolate right away; other isolates see the change within those 3 seconds. A lookup that started before such a write keeps nothing, so it can't put the old view back.

**Privacy in logs.** Logs and traces never carry emails, names or party codes. They refer to a party by `party.ref`, a 12-hex-digit HMAC of its code keyed from `JWT_PRIVATE_KEY` (`src/utils/logRef.ts`), so a party's requests can be followed but its code can't be recovered.

**HTTP.** Only the origins in `ALLOWED_ORIGINS` (`wrangler.jsonc`) get CORS headers. Responses carry HSTS, `X-Frame-Options`, `nosniff` and a no-referrer policy.

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

The API is a standard Worker; its settings are in `wrangler.jsonc`:

- **Production** (top level): the custom domain, `PUBLIC_URL`, `FRONTEND_URL` (where emailed links point), `ALLOWED_ORIGINS`, the sender address, the rate-limit bindings and the log destinations.
- **PR previews** (`env.preview` and its `previews` block): [Worker Previews](https://developers.cloudflare.com/workers/previews/) of a separate Worker, each with its own empty storage. They are public, so they only email the addresses in `EMAIL_ALLOWLIST` (addresses and `@domains`).

The one secret is `JWT_PRIVATE_KEY`, a P-256 private key in PKCS#8 PEM:

```bash
npx wrangler secret put JWT_PRIVATE_KEY
npx wrangler deploy --env=""
```

CI (`.github/workflows/`) runs the checks on every pull request, deploys it as a Preview and smoke-tests it, then deploys `main` to production. Pull-request jobs only get a token that can edit the preview Worker; the production token is limited to deployments from `main`. Third-party actions are pinned to commit SHAs, and Dependabot proposes action and npm updates weekly, a week after each release.

**Turning on the session changes.** Both are off until switched on in `wrangler.jsonc` (and can be tried on previews first):
1. `SEAL_TOKEN_EMAIL`: one release after the code that reads sealed emails is deployed, so a rollback never meets a token it can't read. Check first that the app doesn't read `email` from the token (it should use `GET /v1/me`).
2. `REQUIRE_BOUND_SESSIONS`: 30 days after the app starts binding sessions at sign-in. By then every unbound token has expired, so nobody is signed out early.

**After the first deploy with `REQUIRE_BOUND_SESSIONS` on,** check it by hand, since the smoke checks can't sign in (they have no mailbox): sign in on gnomik.me, open a party, and draw a test party. Any 401 means the proofs' URL doesn't match what the Worker sees on that host. Turn `REQUIRE_BOUND_SESSIONS` off again (a one-line change and a redeploy) and fix it. The smoke checks do cover the headers the app needs: `dpop` allowed in requests, `DPoP-Time` readable.

**Data maintenance.** `scripts/data.ts` works on production data through the Cloudflare API's Durable Object SQL endpoint (a token with Workers Scripts Write):

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/data.ts count          # drawn parties (the Party'o'meter's start)
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/data.ts tidy           # what the clean-up would change
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/data.ts tidy --apply   # change it
```

The Party'o'meter starts from `ROLLED_BEFORE_COUNTER` in `src/do/StatsDO.ts` (29, counted 2026-10-26): recount with `count` right before the first deploy.

**Rotating the signing key.** The frontend verifies tokens with the matching public key (`publicKey` in santa-barbara's `src/config.json`), so update both together. Rotating signs everyone out, and retires every sealed email with the tokens that carry them.

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out jwt.pem
openssl pkey -in jwt.pem -pubout                     # the public key, for the frontend
npx wrangler secret put JWT_PRIVATE_KEY < jwt.pem
rm jwt.pem
```

## Operations

Logs (`console.*` and Cloudflare's request logs) and traces go to Workers Logs, and can be exported over OpenTelemetry through the destinations named in `wrangler.jsonc`. Every route runs in a span named `api.<action>` (`api.createParty`, `api.joinParty`, `api.party`, …) with the action, the internal user id, the outcome (`api.status`, `api.error_code`) and details such as `party.ref`; Durable Object calls show up as child spans. An unexpected error returns a 500 with an `errorId`, logged with the error (`message: "Unhandled error"`).

## Credits

The open-source libraries this API uses are listed in [CREDITS.md](CREDITS.md).
