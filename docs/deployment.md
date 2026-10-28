# Deployment

How to deploy, configure, and operate Santa Monica. For the short version, see the [README](../README.md#deploy).

---

## Environments

Settings live in `wrangler.jsonc`.

| Environment | Where | What's configured |
|---|---|---|
| Production | Top level | Custom domain, `PUBLIC_URL`, `FRONTEND_URL` (where emailed links point), `ALLOWED_ORIGINS`, sender address, rate-limit bindings, log destinations |
| PR previews | `env.preview` and its `previews` block | [Worker Previews](https://developers.cloudflare.com/workers/previews/) of a separate Worker, each with its own empty storage |

> [!WARNING]
> Previews are public. They only email addresses in `EMAIL_ALLOWLIST` (full addresses and `@domains`).

---

## Secrets

The one secret is `JWT_PRIVATE_KEY` (and `JWT_PRIVATE_KEY_PREVIOUS` while it's [rotated](#rotate-the-key)). Every token key and log-ref key is derived from it with HKDF, so any long random secret works. A P-256 private key in PKCS#8 PEM works too.

```bash
npx wrangler secret put JWT_PRIVATE_KEY
npx wrangler deploy --env=""
```

### Rotate the key

Only the Worker uses the key, so nothing else needs updating. Tokens made with the old key keep working while it's in `JWT_PRIVATE_KEY_PREVIOUS`, so nobody is signed out:

1. Put the current key in `JWT_PRIVATE_KEY_PREVIOUS`. Cloudflare can't show a secret again, so this takes the copy you keep of it.
2. Put a new key in `JWT_PRIVATE_KEY`.
3. After 30 days (the longest a session lasts), delete `JWT_PRIVATE_KEY_PREVIOUS`.

```bash
npx wrangler secret put JWT_PRIVATE_KEY_PREVIOUS < current-key.txt
openssl rand -base64 48 | npx wrangler secret put JWT_PRIVATE_KEY
# 30 days later:
npx wrangler secret delete JWT_PRIVATE_KEY_PREVIOUS
```

Either way, from the switch on:

- Every `party.ref` in logs changes, so a party's requests can't be followed across it.
- The per-address email limit starts over (it counts over a minute anyway).

Without the current key (lost, or leaked and to be retired at once), skip step 1. That signs everyone out and voids every emailed link and live ticket.

---

## CI

Workflows live in `.github/workflows/`.

1. Every pull request runs the checks, deploys as a Preview, and smoke-tests it.
2. `main` deploys to production.

**Permissions.** Pull-request jobs only get a token that can edit the preview Worker. The production token is limited to deployments from `main`.

**Supply chain.** Third-party actions are pinned to commit SHAs. Dependabot proposes action and npm updates weekly, a week after each release.

---

## Releasing encrypted tokens

The API and the web app ship together. In the same release, the app stops reading tokens and binds sessions at sign-in.

- Tokens issued before the release stop working, so everyone signs in once.
- Older emailed links stop working.

---

## Bound sessions (`REQUIRE_BOUND_SESSIONS`)

It's on: only [bound sessions](security.md#bound-sessions-dpop) are accepted, in production and on previews. The web app binds every sign-in since its #220. A session from before then gets one `401`, and its owner signs in again.

### Check it after a deploy that touches sessions

Smoke checks can't sign in (they have no mailbox), so check by hand:

1. Sign in on gnomik.me.
2. Open a party.
3. Draw a test party.

If you see a `401`, the proofs' URL doesn't match what the Worker sees on that host. Set `REQUIRE_BOUND_SESSIONS` to `"false"` in `wrangler.jsonc` (a one-line change and a redeploy), then fix it.

The smoke checks do cover the headers the app needs: `dpop` allowed in requests, and `DPoP-Time` readable.

---

## Maintain data

`scripts/data.ts` works on production data through the Cloudflare API's Durable Object SQL endpoint. It needs a token with Workers Scripts Write.

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
```

| Command | What it does |
|---|---|
| `node scripts/data.ts count` | Counts drawn and open parties. Drawn is the Party'o'meter's starting point. |
| `node scripts/data.ts tidy` | Shows what clean-up would change. |
| `node scripts/data.ts tidy --apply` | Applies the clean-up. |
| `node scripts/data.ts wake` | Starts every open party once. Run it after the auto-prune deploy. |

### Auto-prune at deploy

Parties nobody opens never start on their own. Run `wake` once after the deploy that brings auto-prune:

1. Each open party starts and gets its prune date from its last activity.
2. A party that went quiet before `AUTO_PRUNE_SINCE` (in `src/do/PartyDO.ts`) is erased by its alarm, with no email. Keep `AUTO_PRUNE_SINCE` no later than the deploy day.
3. Run `count` to see what's still open.

### Party'o'meter starting count

The Party'o'meter starts from `ROLLED_BEFORE_COUNTER` in `src/do/StatsDO.ts` (29, counted 2026-10-26). Recount with `count` right before the first deploy.

---

## How data moves

- `PartyDO` writes changes that other objects need (members' party lists, draw emails) to an **outbox** in the same transaction. The outbox delivers them with retries.
- An alarm deletes open parties after 45 days without activity, and erases deleted parties once they can no longer be restored.

---

## Monitoring

Logs (`console.*` and Cloudflare's request logs) and traces go to Workers Logs. They can be exported over OpenTelemetry through the destinations in `wrangler.jsonc`.

Every route runs in a span named `api.<action>`, such as `api.createParty`, `api.joinParty`, or `api.lookUpParty`. Spans carry:

| Attribute | Meaning |
|---|---|
| `api.status`, `api.error_code` | The outcome |
| `party.ref` | The party, as an HMAC of its code |
| `rate_limit.hit` | The limit that refused the request |

Spans also carry the action and the internal user id. Durable Object calls show up as child spans.

An unexpected error returns a `500` with an `errorId`. The same id is logged with the error (`message: "Unhandled error"`).

---

## Tests

| Command | What it covers |
|---|---|
| `npm run test:unit` | Every module directly. Requires 100% coverage of lines, branches, functions, and statements (report in `coverage/`). Also pins how many Durable Object calls each route makes, and checks that lists and parties cost the same however much they hold (`test/unit/efficiency.test.ts`). |
| `npm run test:integration` | Every flow end to end through the Worker's real entry point, following links in emails the way a person would. Email goes to a test mail sink (`test/integration/mail-sink.js`). |
| `npm run smoke` | Read-only checks against a deployed API (`SMOKE_URL=https://...`). |
