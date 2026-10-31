[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/banner2-direct.svg)](https://savelife.in.ua/en/)

> [!IMPORTANT]
> Russia is waging a full-scale war against Ukraine. Please help Ukraine's defenders: donate to [Come Back Alive](https://savelife.in.ua/en/).
>
> **Be brave like Ukraine** 🇺🇦 [Stand with Ukraine](https://savelife.in.ua/en/)

![Welcome to Santa Monica](santa-monica.jpg)

# Santa Monica API

Santa Monica is the API behind [Anonymous Santa Clauses](https://gnomik.me), a Secret Santa app. Use it to sign people in with emailed links, host and join parties, and draw who gives a gift to whom.

The web app that uses it lives in [santa-barbara](https://github.com/uglyunicorn-eh/santa-barbara).

**Base URL:** `https://api.gnomik.me/v1`

## Run the API locally

Before you begin, install Node.js 22.

1. Install the dependencies:

   ```bash
   npm install
   ```

2. Create your local settings, and set `JWT_PRIVATE_KEY` to any long random string:

   ```bash
   cp .dev.vars.example .dev.vars
   ```

3. Start the API. It runs at `http://localhost:8787`.

   ```bash
   npm run dev
   ```

### Run the web app against it

1. Start the API with `npx wrangler dev --env preview`. This environment allows the app's local origins (`localhost:4321` to `4323`) and writes sent emails to files instead of sending them.
2. Start santa-barbara with `PUBLIC_API_ENDPOINT=http://localhost:8787`.

## How it works

The API is a Cloudflare Worker. All data lives in Durable Objects with SQLite storage.

| Component | What it does |
|---|---|
| Worker ([Hono](https://hono.dev)) | Serves the JSON API. |
| `PartyDO` | One object per party: its members, the draw, and an outbox that delivers emails and updates to other objects. |
| `UserDO` | One object per account, keyed by email address: the profile, the party list, and the session version. Stores nothing until the first sign-in. |
| `StatsDO` | The Party'o'meter: how many parties have rolled their dice. |
| Cloudflare Email Service | Sends email from `info@gnomik.me`. |

```
src/
  index.ts   app setup, headers, CORS, errors
  api/       routes, schemas, sessions, rate limits
  do/        Durable Objects
  mail/      email templates
  utils/     tokens, IDs, the draw, tracing
```

## Authentication

Send the session token in the `Authorization` header:

```
Authorization: Bearer <userToken>
```

To get a session token:

1. Call `POST /auth/magic-link` with the person's email address. They receive an email with a sign-in link.
2. Call `POST /auth/session` with the token from that link. The response contains `userToken`, `user`, `expiresAt`, and `party`.

Sessions last 30 days. Treat every token as an opaque string: tokens are encrypted, and only the API can read them.

> [!IMPORTANT]
> Production accepts only bound sessions. Pass a public `key` (a P-256 JWK) when you create a session, then sign each request with a `DPoP` proof from the matching private key. A leaked token is useless without the key. See [Bound sessions](docs/security.md#bound-sessions-dpop).

## API overview

For parameters, responses, and errors, see the [API reference](docs/api.md).

### Sessions

| Endpoint | Description |
|---|---|
| [`POST /auth/magic-link`](docs/api.md#send-a-magic-link) | Emails a sign-in link. |
| [`POST /auth/magic-link/again`](docs/api.md#resend-an-expired-link) | Emails a fresh link for an expired sign-in link, invite, or party sign-in link. |
| [`POST /auth/session`](docs/api.md#create-a-session) | Signs in with a magic link. |
| [`POST /auth/invite`](docs/api.md#accept-an-invite) | Signs in with an invite and joins the party in one step. |
| [`POST /auth/party-link`](docs/api.md#sign-in-with-a-party-link) | Signs a member in with the link in a party's emails. |

### Users

| Endpoint | Description |
|---|---|
| [`GET /me`](docs/api.md#retrieve-the-current-user) | Retrieves the signed-in user. |
| [`PATCH /me`](docs/api.md#update-the-current-user) | Updates the profile name. |
| [`GET /me/parties`](docs/api.md#list-the-users-parties) | Lists the user's parties, newest first. |
| [`GET /me/parties/unrevealed`](docs/api.md#list-unrevealed-parties) | Lists rolled parties where the user hasn't seen their match. |
| [`POST /me/parties/revealed`](docs/api.md#mark-a-party-as-revealed) | Records that the user saw their match. |
| [`POST /me/sign-out`](docs/api.md#sign-out-everywhere) | Signs out every device. |
| [`POST /me/email-change`](docs/api.md#request-an-email-change) | Emails a link to confirm a new address. |
| [`POST /me/email-change/confirm`](docs/api.md#confirm-an-email-change) | Moves the account to the new address. |
| [`POST /me/email-change/cancel`](docs/api.md#cancel-an-email-change) | Stops an email change and signs out everywhere. |
| [`POST /me/deletion`](docs/api.md#request-account-deletion) | Emails a link to delete the account. |
| [`POST /me/deletion/check`](docs/api.md#check-a-deletion-link) | Checks a deletion link without using it. |
| [`POST /me/deletion/confirm`](docs/api.md#confirm-account-deletion) | Deletes the account. |

### Parties

| Endpoint | Description |
|---|---|
| [`POST /parties/lookup`](docs/api.md#retrieve-a-party) | Retrieves a party by its code. |
| [`POST /parties`](docs/api.md#create-a-party) | Creates a party. |
| [`POST /parties/join`](docs/api.md#join-a-party) | Joins a party. |
| [`POST /parties/leave`](docs/api.md#leave-a-party) | Leaves a party. |
| [`POST /parties/draw`](docs/api.md#roll-the-dice) | Rolls the dice. Host only. |
| [`POST /parties/invite`](docs/api.md#invite-people) | Emails invites. Host only. |
| [`POST /parties/delete`](docs/api.md#delete-a-party) | Deletes a party. Host only. |
| [`POST /parties/restore`](docs/api.md#restore-a-party) | Restores a deleted party. Host only. |

### Live updates

| Endpoint | Description |
|---|---|
| [`POST /live/ticket`](docs/api.md#create-a-ticket) | Creates a ticket for a live-updates WebSocket. |
| [`GET /parties/live`](docs/api.md#watch-a-party) | Opens a WebSocket for a party. |
| [`GET /me/live`](docs/api.md#watch-the-account) | Opens a WebSocket for the user's account. |
| [`GET /stats`](docs/api.md#retrieve-the-partyometer) | Retrieves the Party'o'meter. |
| [`GET /stats/live`](docs/api.md#watch-the-partyometer) | Opens a WebSocket for the Party'o'meter. |

## Errors

Every error has the same shape:

```json
{ "error": { "code": "not_found", "message": "Party does not exist.", "field": "party" } }
```

Branch on `code`, not on `message`. A `401` always means the session is missing, invalid, or revoked: sign the person out when you get one. See [Errors](docs/api.md#errors) for every code.

## Idempotent requests

Every write is safe to retry. Routes that send email or create something also accept an `Idempotency-Key` header. A retry with the same key within 10 minutes returns the same response without doing the work again. See [Idempotent requests](docs/api.md#idempotent-requests).

## Rate limits

| What | Limit |
|---|---|
| Party codes tried | 60 per minute per IP, or 10 for older 5-letter codes |
| Joins | 10 per minute per user |
| Wrong secret phrases | 5 per person and 20 per party, every 15 minutes |
| Emails | 10 per minute per IP, 3 per minute per address, and about 60 per minute overall |
| Invites | 10 addresses per request, 3 requests per minute, and 50 per party |
| Open parties | 3 per host |
| New parties | 10 per day per person |
| Party size | 100 people |
| Names | 32 characters for a person, 48 for a party |
| Request body | 16 KB |

A refused request returns `429` with `Retry-After: 60`. See [Rate limits](docs/security.md#rate-limits) for how limits are checked.

## Security and privacy

- **Encrypted tokens.** Every token is a JWE (`dir` + `A256GCM`) with a key derived from `JWT_PRIVATE_KEY`.
- **Revocation.** Signing out, changing the email address, or deleting the account ends every session at once.
- **Single-use links.** Every emailed link works once. Sign-in links last 5 minutes and account links 1 hour.
- **No account enumeration.** The API never reveals whether an address has an account.
- **Fair draw.** The draw is uniformly random and uses a cryptographic random source (`src/utils/santaShuffle.ts`).
- **Minimal data.** A party drops members' email addresses after the draw. Open parties with no activity for 45 days are deleted.
- **Clean logs.** Logs never contain email addresses, names, or party codes.

To learn more, see [Security and privacy](docs/security.md).

## Test the API

```bash
npm run typecheck
npm run test:unit          # requires 100% coverage
npm run test:integration   # end-to-end flows through the Worker
SMOKE_URL=https://... npm run smoke   # read-only checks against a deployed API
```

In integration tests, email to an address that starts with `fail+` simulates a failed delivery.

## Deploy the API

Settings live in `wrangler.jsonc`. The only secret is `JWT_PRIVATE_KEY`, plus `JWT_PRIVATE_KEY_PREVIOUS` while you rotate it.

```bash
npx wrangler secret put JWT_PRIVATE_KEY
npx wrangler deploy --env=""
```

CI tests every pull request, deploys it as a [Worker Preview](https://developers.cloudflare.com/workers/previews/), and deploys `main` to production. Previews email only addresses in `EMAIL_ALLOWLIST`.

To rotate the signing key, maintain production data, or turn off bound sessions, see [Deployment](docs/deployment.md).

## Monitor the API

Logs and traces go to Workers Logs, and you can export them over OpenTelemetry. Each route runs in a span named `api.<action>` with `api.status`, `api.error_code`, and `rate_limit.hit`. See [Monitoring](docs/deployment.md#monitor-the-api).

## Credits

See [CREDITS.md](CREDITS.md).
