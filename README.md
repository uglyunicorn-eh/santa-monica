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
  - `PartyDO`, one per party, keyed by its code: the party, its members and the draw. Changes other objects need (members' party lists, draw emails) go through an outbox in the same transaction and are delivered with retries; an alarm deletes open parties after 45 days without activity, and erases deleted parties once they can no longer be restored.
  - `UserDO`, one per email address that has signed in: the profile, a summary of the user's parties, the session token version, and the bookkeeping for repeated account requests and used links. It makes its tables on its first write, so an address that never signs in has nothing stored: a sign-in request keeps everything in its link.
  - `StatsDO`, just one: the Party'o'meter, how many parties have rolled their dice, ever. Viewers watch it over a WebSocket.
- **Email** goes through Cloudflare Email Service (`send_email` binding), from `info@gnomik.me`.
- **Tokens** (sessions, live tickets, emailed links) are encrypted JWTs (JWE, `dir` + `A256GCM`) with a key derived from `JWT_PRIVATE_KEY`, so only the Worker can read them. The frontend treats them as opaque strings. A session can be bound to a key the browser keeps (DPoP, see Security).

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
| `POST /v1/auth/magic-link/again` `{token}` | — | Emails a fresh sign-in link for an expired one (up to 7 days past expiry), to the address and party inside it (202) |
| `POST /v1/auth/session` `{token, key?}` | link | Signs in with that link: `{userToken, user, expiresAt, party}` (`party`: the link's party code, or null). With `key`, the session is bound to it. An expired link is `link_expired` |
| `GET /v1/me` | yes | The signed-in user |
| `PATCH /v1/me` `{name}` | yes | Sets the profile name |
| `GET /v1/me/parties?first&after` | yes | My parties, newest first: `{items, hasMore, endCursor}` (`first` 1–100, default 10) |
| `POST /v1/me/email-change` `{email}` | yes | Emails a confirmation link to the new address, and a notice with a cancel link to the current one (202) |
| `POST /v1/me/email-change/confirm` `{token, key?}` | link | Moves the account to the new address: `{userToken, user, expiresAt, party: null}`. With `key`, the session is bound to it |
| `POST /v1/me/email-change/cancel` `{token}` | link | "This wasn't me": stops the change and signs out everywhere |
| `POST /v1/me/sign-out` | yes | Signs out every device, this one included |
| `POST /v1/me/deletion` | yes | Emails a link that deletes the account (202) |
| `POST /v1/me/deletion/confirm` `{token}` | link | Deletes the account |
| `POST /v1/parties/lookup` `{code}` | optional | A party, as this person sees it, with its `dueAt` (or null) for the app's countdown |
| `POST /v1/parties` `{name, password?, dueAt?}` | yes | Creates a party (201). `dueAt`, optional, is when it's due: an ISO date-time with its offset, 1 hour to 366 days ahead |
| `POST /v1/parties/join` `{code, name, password?}` | yes | Joins |
| `POST /v1/parties/leave` `{code}` | yes | Leaves |
| `POST /v1/parties/draw` `{code}` | yes | Draws (host only) |
| `POST /v1/parties/invite` `{code, emails}` | yes | Emails invites to up to 10 addresses (host only, open parties): `{invited, alreadyInvited, alreadyJoined, invitesLeft}` |
| `POST /v1/parties/delete` `{code}` | yes | Deletes an open party (host only); restorable for 24 hours. An open party with no activity for 45 days is deleted on its own, restorable for 7 days |
| `POST /v1/parties/restore` `{code}` | yes | Restores it (host only) |
| `POST /v1/live/ticket` `{code?}` | yes | A ticket for a live-updates socket, valid 5 minutes: with `code`, for that party's (`GET /v1/parties/live?ticket=`), otherwise for my own (`GET /v1/me/live?ticket=`) |
| `GET /v1/stats` | — | The Party'o'meter: `{rolled}`, how many parties have rolled their dice |
| `GET /v1/stats/live` | — | The same as a WebSocket: `{"type":"stats","rolled":N}` on connect and after every roll |

- **Errors** always answer `{ "error": { "code", "message", "field" } }`: 400 `invalid` / `invalid_link` / `link_expired`, 401 `unauthenticated`, 403 `forbidden`, 404 `not_found`, 409 `conflict` / `link_used` / `account_busy`, 429 `rate_limited`, 503 `unavailable` / `not_finished`, and 500 `internal` with an `errorId` that is also logged with the error. **401 only ever means the session is missing, invalid or revoked**: the frontend signs out on it.
- **Input and output are [valibot](https://valibot.dev) schemas** (`src/api/schemas.ts`). Bodies are strict objects of bounded, trimmed text fields (`src/api/limits.ts`; the web app's forms should use the same numbers); unknown fields and anything over a limit are refused by name. Responses are shaped from stored records by output schemas, so nothing else leaves the Worker.
- **Every write is safe to repeat.** Joining, leaving, drawing, deleting, restoring and renaming answer with the current state when already done; an invite skips the addresses already invited that day. Routes that send email or create something take an `Idempotency-Key` header (16–100 letters, digits, `-`, `_`): a repeat within ten minutes gets the same answer without sending or creating again. Emailed links are single-use, but the request that used one can repeat with the same key and get the same outcome.
- **A party code never appears in a URL.** The lookup and every write take it in the body, and a party's live socket gets it from its ticket, so it stays out of browser history, proxy logs and request logs.

## Security

**Sessions.** Session tokens last 30 days and carry the account's token version. Every signed-in route checks it, either in the Durable Object call the route makes anyway or with one read of the user (`session.verify()`). Signing out everywhere, changing the email, deleting the account and "This wasn't me" bump the version, which ends every session at once. `test/integration/revocation.test.ts` calls every route with a revoked token and fails if a new route is missing from it.

**Bound sessions (DPoP, RFC 9449).** At sign-in the app can send a public key (a P-256 JWK with only `kty`, `crv`, `x`, `y`) from a key pair it can't export. The session token then carries the key's thumbprint (`cnf.jkt`), and every request with it needs a `DPoP` proof signed by that key, for that method, URL and token, made within a minute (`src/utils/dpop.ts`). On routes that change something, each proof works for one request only: the user's object records its `jti` in the session check every signed-in route already makes (`UserDO.holds`), at no extra call. Reads (GET routes and the lookups) check the proof but don't record it, so they write nothing. So a token copied out of a HAR file, a log or a header is useless on its own; with the proof that came with it, it can at most re-send that one read, to that URL, within its minute. A missing or wrong proof is a 401. A proof that's only off on its clock is a 400 with the Worker's time in `DPoP-Time`, so the app can correct its clock and retry instead of signing out. `REQUIRE_BOUND_SESSIONS` makes bound tokens the only ones that count.

**Tokens are encrypted.** Every token is a JWE (`dir` + `A256GCM`, `src/utils/jwt.ts`) with a 256-bit key derived from `JWT_PRIVATE_KEY` by HKDF. GCM's tag proves the Worker made it, and nothing in it (an email, a party code) can be read by anyone holding it. The type travels in the authenticated header. The app gets what it used to read from tokens in the answers instead: `expiresAt` and `party` at sign-in, `link_expired` for an old link, and `POST /v1/auth/magic-link/again` to swap an expired link for a fresh one.

**Emailed links.** Sign-in links last 5 minutes (an expired one can ask for a fresh one for 7 days); account links (email change, deletion, cancel) last an hour. Each works once. Account links carry the token version they were issued for, so any version bump voids every pending one: someone with a stolen session may have asked for several.

**Email addresses.** Accounts are keyed by the normalized address (`canonicalEmail` in `src/utils/email.ts`): lowercased, and for Gmail also without a `+tag`, with `googlemail.com` read as `gmail.com`, since Gmail delivers those to one mailbox. Dots are kept, so the address reads the way its owner typed it. Accounts saved under an older spelling (as typed, or a Gmail address without its dots) move to the normalized one on their owner's next sign-in. Asking to move an account to an address that already has one answers like any other request, and that address gets a notice instead of a link, so the API never reveals which addresses have accounts.

**Limits.** A party code is the key to a party without a secret phrase, so codes are hard to guess and slow to try:

| What | Limit | Where |
|---|---|---|
| Party codes | 8 letters (about 2·10^11); older parties keep 5-letter codes | `src/api/schemas.ts` |
| Party codes tried per IP | 60 a minute; 10 a minute for 5-letter codes. Every route that takes a code counts (lookups and all party writes), since each one tells whether the party exists; so do sign-in links to 5-letter codes | `PARTY_LOOKUP_RATE_LIMIT_IP`, `LEGACY_CODE_LOOKUP_RATE_LIMIT_IP` |
| Joins per user | 10 a minute | `JOIN_RATE_LIMIT_USER` |
| Wrong secret phrases | 5 per person and 20 per party in 15 minutes; the right phrase always gets in | `src/do/PartyDO.ts` |
| Emails | 10 a minute per IP, and 3 a minute per address (invites included), counted by a hash of the address so nothing is stored for it. The notice of an email change to the current address is never held back | `ENTER_RATE_LIMIT_IP`, `MAIL_RATE_LIMIT_ADDRESS`, `src/api/rateLimit.ts` |
| Emails, all addresses together | 60 a minute, roughly: a backstop so a spike or a spam run can't use up the sending quota. Taken right before an email is sent (requested emails and party invites), so refused requests don't use it up. Over it, a requested email is a 429 and an invite waits for the outbox's next try | `MAIL_RATE_LIMIT_ALL` |
| Party'o'meter sockets | 30 a minute per IP | `STATS_WATCH_RATE_LIMIT_IP` |
| Invites | Up to 10 addresses a request and 3 requests a minute per host; 50 per party in all; one per address per party a day | `INVITE_RATE_LIMIT_USER`, `MAX_PARTY_INVITES` in `src/do/PartyDO.ts` |
| Open parties per host | 3 | `src/api/routes/parties.ts` |
| People per party | 100, host included; a join after that is refused with "This party is full" | `MAX_PARTY_MEMBERS` in `src/do/PartyDO.ts` |
| New parties per person | 10 a day, deleted ones included (restoring one doesn't count) | `MAX_NEW_PARTIES_PER_DAY`, counted by `UserDO` |
| Names | 32 characters for a person (profile and join name), 48 for a party; names saved before keep their length | `src/api/limits.ts` |
| Request body | 16 KB | `src/api/limits.ts` |

All the Cloudflare rate limits go through `take` and `admit` in `src/api/rateLimit.ts`, with their messages in one table (`REFUSALS`). They're checked one at a time, broadest first (per client, then per user or address, then all emails together), and a later one is counted only when the earlier ones let the request through. A refusal is a 429 with `Retry-After: 60`, readable by the app, and the trace records which limit it was as `rate_limit.hit`. Cloudflare's rate limits are counted per location and approximately; the phrase and new-party limits are counted exactly by the Durable Objects. The per-address email limit is a Rate Limiting binding on purpose, so an address that never signs in leaves nothing stored. The trade-off: it counts per minute, not per hour, so someone who knows an address can send it about 3 sign-in links a minute.

**The draw** is uniformly random over every way to give everyone one target other than themselves (`src/utils/santaShuffle.ts`, with a cryptographic random source), so nobody can guess who drew whom better than by chance.

**What we keep.** The profile (email, name), the parties you're in, and for each party its members. A party lets go of its members' emails once it's drawn and the draw's emails have gone out; after that it knows members by id. Invited addresses are kept for a day only, to skip repeat invites. A deleted account keeps neither its name nor its email. Expired link and request records are deleted when the object starts. A sign-in request, an invite or an email-change request to a new address stores nothing for that address; it gets a record only once a link is used. An open party with no activity for 45 days is deleted (its host gets an email and can restore it for a week), then erased with its members' emails. Each object does this itself; `scripts/data.ts tidy` does it for objects nobody opens any more. Cloudflare keeps 30 days of point-in-time history, so deleted data stays there that long. Stored data isn't encrypted by the app: Cloudflare encrypts it on disk, and anyone who could read it otherwise (Data Studio needs Editor access to the Worker) could also deploy code that reads any key. Keeping less is what protects it.

**Due times.** A party can be given a due time when it's created. The app counts down to it, and nothing happens when it passes. The host gets one reminder email the day before, at the time of day the party was created (`reminderAt` in `src/do/PartyDO.ts`: 12 to 36 hours ahead, whatever their time zone), through the party's alarm and outbox. Like auto-prune, it's only for an open party: a drawn one gets none, and a deleted one keeps it for when it's restored (unless the due time has passed by then).

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

The one secret is `JWT_PRIVATE_KEY`. Its text is the key material that every token key and log ref key is derived from (HKDF), so any long random secret works; a P-256 private key in PKCS#8 PEM, as before, is fine:

```bash
npx wrangler secret put JWT_PRIVATE_KEY
npx wrangler deploy --env=""
```

CI (`.github/workflows/`) runs the checks on every pull request, deploys it as a Preview and smoke-tests it, then deploys `main` to production. Pull-request jobs only get a token that can edit the preview Worker; the production token is limited to deployments from `main`. Third-party actions are pinned to commit SHAs, and Dependabot proposes action and npm updates weekly, a week after each release.

**Releasing encrypted tokens.** The API and the web app ship together: the app stops reading tokens and binds sessions at sign-in in the same release. Tokens issued before it stop working, so everyone signs in once, and older emailed links stop working.

**Turning on `REQUIRE_BOUND_SESSIONS`.** Off until switched on in `wrangler.jsonc` (try it on a preview first). Every session starts fresh with the encrypted-token release, so it can be on from that release, once the web app binds at sign-in.

**After the first deploy with `REQUIRE_BOUND_SESSIONS` on,** check it by hand, since the smoke checks can't sign in (they have no mailbox): sign in on gnomik.me, open a party, and draw a test party. Any 401 means the proofs' URL doesn't match what the Worker sees on that host. Turn `REQUIRE_BOUND_SESSIONS` off again (a one-line change and a redeploy) and fix it. The smoke checks do cover the headers the app needs: `dpop` allowed in requests, `DPoP-Time` readable.

**Data maintenance.** `scripts/data.ts` works on production data through the Cloudflare API's Durable Object SQL endpoint (a token with Workers Scripts Write):

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/data.ts count          # drawn and open parties (drawn: the Party'o'meter's start)
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/data.ts tidy           # what the clean-up would change
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/data.ts tidy --apply   # change it
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/data.ts wake           # start every open party once (after the auto-prune deploy)
```

**Auto-prune at deploy.** Parties nobody opens never start on their own, so run `wake` once after the deploy that brings auto-prune: each open party starts, gets its prune date from its last activity, and one that went quiet before `AUTO_PRUNE_SINCE` (in `src/do/PartyDO.ts`; keep it no later than the deploy day) is erased by its alarm with no email. `count` then shows what's still open.

The Party'o'meter starts from `ROLLED_BEFORE_COUNTER` in `src/do/StatsDO.ts` (29, counted 2026-10-26): recount with `count` right before the first deploy.

**Rotating the key.** Only the Worker uses it, so there's nothing to update elsewhere. Rotating signs everyone out, voids every emailed link and live ticket, and changes every `party.ref` in logs from then on.

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out jwt.pem
npx wrangler secret put JWT_PRIVATE_KEY < jwt.pem
rm jwt.pem
```

## Operations

Logs (`console.*` and Cloudflare's request logs) and traces go to Workers Logs, and can be exported over OpenTelemetry through the destinations named in `wrangler.jsonc`. Every route runs in a span named `api.<action>` (`api.createParty`, `api.joinParty`, `api.lookUpParty`, …) with the action, the internal user id, the outcome (`api.status`, `api.error_code`) and details such as `party.ref`, or `rate_limit.hit` naming the limit that refused it; Durable Object calls show up as child spans. An unexpected error returns a 500 with an `errorId`, logged with the error (`message: "Unhandled error"`).

## Credits

The open-source libraries this API uses are listed in [CREDITS.md](CREDITS.md).
