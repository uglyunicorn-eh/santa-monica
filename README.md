[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/banner2-direct.svg)](https://savelife.in.ua/en/)

> [!IMPORTANT]
> Russia is waging a full-scale war against Ukraine. Please help Ukraine's defenders: donate to [Come Back Alive](https://savelife.in.ua/en/).
>
> **Be brave like Ukraine** 🇺🇦 [Stand with Ukraine](https://savelife.in.ua/en/)

![Welcome to Santa Monica](santa-monica.jpg)

# Santa Monica API

Santa Monica is the API behind [Anonymous Santa Clauses](https://gnomik.me), a Secret Santa app. Use it to sign people in with a magic link, host and join parties, and draw who gives a gift to whom.

The web app lives in [santa-barbara](https://github.com/uglyunicorn-eh/santa-barbara).

**Base URL:** `https://api.gnomik.me/v1`

---

## Quickstart

You need Node.js 22.

```bash
npm install
cp .dev.vars.example .dev.vars   # set JWT_PRIVATE_KEY
npm run dev                      # http://localhost:8787
```

To run the web app against your local API:

1. Start the API with `npx wrangler dev --env preview`. It allows `localhost:4321`–`4323` and writes sent emails to files.
2. Start santa-barbara with `PUBLIC_API_ENDPOINT=http://localhost:8787`.

---

## How it works

| Piece | What it does |
|---|---|
| Cloudflare Worker ([Hono](https://hono.dev)) | Serves the JSON API. |
| `PartyDO` | One Durable Object per party: members, the draw, and an outbox for emails and cross-object updates. |
| `UserDO` | One per signed-in email address: profile, parties, session version. Stores nothing until the first sign-in. |
| `StatsDO` | The Party'o'meter: how many parties have rolled their dice. |
| Cloudflare Email Service | Sends email from `info@gnomik.me`. |

All data lives in Durable Objects with SQLite storage.

```
src/
  index.ts   app setup, headers, CORS, errors
  api/       routes, schemas, sessions, rate limits
  do/        Durable Objects
  mail/      email templates
  utils/     tokens, ids, the draw, tracing
```

---

## Authentication

Send the session token in the `Authorization` header:

```
Authorization: Bearer <session token>
```

To get a token:

1. Call `POST /auth/magic-link` with `{email}`. The user gets an email.
2. Call `POST /auth/session` with the `{token}` from the link. You get `{userToken, user, expiresAt, party}`.

Sessions last 30 days. Treat every token as an opaque string: tokens are encrypted, and only the Worker can read them.

> [!TIP]
> Pass a public `key` (P-256 JWK) when you create a session: it binds the session to the browser with [DPoP](docs/security.md#bound-sessions-dpop), and only bound sessions are accepted. Each request then needs a `DPoP` proof signed by that key, so a leaked token is useless on its own.

---

## API reference

### Auth

| Endpoint | Body | Returns |
|---|---|---|
| `POST /auth/magic-link` | `{email, party?}` | `202`. Emails a sign-in link. |
| `POST /auth/magic-link/again` | `{token}` | `202`. Emails a fresh link for one that expired (up to 7 days ago). |
| `POST /auth/session` | `{token, key?}` | A session. |

### Account

| Endpoint | Body | Returns |
|---|---|---|
| `GET /me` | | The signed-in user. |
| `PATCH /me` | `{name}` | The updated user. |
| `GET /me/parties` | `?first&after` | `{items, hasMore, endCursor}`, newest first. |
| `POST /me/email-change` | `{email}` | `202`. Emails a confirmation link. |
| `POST /me/email-change/confirm` | `{token, key?}` | A session on the new address. |
| `POST /me/email-change/cancel` | `{token}` | Stops the change and signs out everywhere. |
| `POST /me/sign-out` | | Signs out every device. |
| `POST /me/deletion` | | `202`. Emails a deletion link. |
| `POST /me/deletion/confirm` | `{token}` | Deletes the account. |

### Parties

Party codes always go in the request body, never in the URL.

| Endpoint | Body | Returns |
|---|---|---|
| `POST /parties/lookup` | `{code}` | The party. Session optional. |
| `POST /parties` | `{name, password?, dueAt?}` | `201`. The new party. |
| `POST /parties/join` | `{code, name, password?}` | The party. |
| `POST /parties/leave` | `{code}` | The party. |
| `POST /parties/draw` | `{code}` | The party. Host only. |
| `POST /parties/invite` | `{code, emails}` | `{invited, alreadyInvited, alreadyJoined, invitesLeft}`. Host only. |
| `POST /parties/delete` | `{code}` | Host only. Restorable for 24 hours. |
| `POST /parties/restore` | `{code}` | Host only. |

### Live updates

| Endpoint | Returns |
|---|---|
| `POST /live/ticket` `{code?}` | A ticket valid for 5 minutes. |
| `GET /parties/live?ticket=` | WebSocket for a party. |
| `GET /me/live?ticket=` | WebSocket for your account. |
| `GET /stats` | `{rolled}`. No session needed. |
| `GET /stats/live` | WebSocket: `{"type":"stats","rolled":N}`. |

---

## Errors

Every error has the same shape:

```json
{ "error": { "code": "not_found", "message": "…", "field": null } }
```

| Status | Codes |
|---|---|
| 400 | `invalid`, `invalid_link`, `link_expired` |
| 401 | `unauthenticated` |
| 403 | `forbidden` |
| 404 | `not_found` |
| 409 | `conflict`, `link_used`, `account_busy` |
| 429 | `rate_limited` (with `Retry-After: 60`) |
| 500 | `internal` (with an `errorId` to find it in logs) |
| 503 | `unavailable`, `not_finished` |

> [!NOTE]
> A `401` always means the session is missing, invalid, or revoked. Sign the user out when you get one.

---

## Idempotency

Every write is safe to retry. Join, leave, draw, delete, restore, and rename return the current state if already done.

Routes that send email or create something accept an `Idempotency-Key` header (16–100 characters: letters, digits, `-`, `_`). A retry within 10 minutes returns the same response without doing the work again.

---

## Rate limits

| What | Limit |
|---|---|
| Party codes tried | 60/min per IP (10/min for old 5-letter codes) |
| Joins | 10/min per user |
| Wrong secret phrases | 5 per person, 20 per party, per 15 min |
| Emails | 10/min per IP, 3/min per address, ~60/min overall |
| Invites | 10 addresses per request, 3 requests/min, 50 per party |
| Open parties | 3 per host |
| New parties | 10/day per person |
| Party size | 100 people |
| Names | 32 characters (person), 48 (party) |
| Request body | 16 KB |

Limits live in `src/api/rateLimit.ts`, `src/api/limits.ts`, and `src/do/PartyDO.ts`. See [Rate limits](docs/security.md#rate-limits) for how they're checked.

---

## Security and privacy

- **Encrypted tokens.** Every token is a JWE (`dir` + `A256GCM`) with a key derived from `JWT_PRIVATE_KEY`.
- **Revocation.** Signing out, changing email, or deleting the account ends every session at once.
- **Single-use links.** Sign-in links last 5 minutes; account links last 1 hour.
- **No account enumeration.** The API never reveals whether an address has an account.
- **Fair draw.** Uniformly random, using a cryptographic source (`src/utils/santaShuffle.ts`).
- **Minimal data.** A party drops members' emails after the draw. Inactive open parties are deleted after 45 days.
- **Clean logs.** Logs never contain emails, names, or party codes. Parties appear as `party.ref`, an HMAC of the code.

For the details, see [Security and privacy](docs/security.md).

---

## Testing

```bash
npm run typecheck
npm run test:unit          # requires 100% coverage
npm run test:integration   # end-to-end flows through the Worker
SMOKE_URL=https://... npm run smoke   # read-only checks on a deployed API
```

In integration tests, recipients starting with `fail+` simulate a failed delivery.

---

## Deploy

Settings live in `wrangler.jsonc`. The one secret is `JWT_PRIVATE_KEY` (plus `JWT_PRIVATE_KEY_PREVIOUS` while it's rotated).

```bash
npx wrangler secret put JWT_PRIVATE_KEY
npx wrangler deploy --env=""
```

CI checks every pull request, deploys it as a [Worker Preview](https://developers.cloudflare.com/workers/previews/), and deploys `main` to production. Previews only email addresses in `EMAIL_ALLOWLIST`.

### Rotate the key

Put the current key in `JWT_PRIVATE_KEY_PREVIOUS` and a new one in `JWT_PRIVATE_KEY`: old tokens keep working, so nobody is signed out. Delete the previous key after 30 days. See [Deployment](docs/deployment.md#rotate-the-key).

### Maintain data

`scripts/data.ts` works on production data. It needs `CLOUDFLARE_API_TOKEN` (Workers Scripts Write) and `CLOUDFLARE_ACCOUNT_ID`.

| Command | What it does |
|---|---|
| `node scripts/data.ts count` | Counts drawn and open parties. |
| `node scripts/data.ts tidy` | Shows what clean-up would change. Add `--apply` to change it. |
| `node scripts/data.ts wake` | Starts every open party once, so auto-prune can schedule it. |

For environments, CI, `REQUIRE_BOUND_SESSIONS`, and release steps, see [Deployment](docs/deployment.md).

---

## Monitoring

Logs and traces go to Workers Logs and can be exported over OpenTelemetry. Each route runs in a span named `api.<action>`, with `api.status`, `api.error_code`, and `rate_limit.hit`.

---

## Credits

See [CREDITS.md](CREDITS.md).
