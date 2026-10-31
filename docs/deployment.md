# Deployment

Learn how to deploy, configure, and operate Santa Monica. For a summary, see the [README](../README.md#deploy-the-api).

## Environments

Settings live in `wrangler.jsonc`.

| Environment | Where it's configured | What's configured |
|---|---|---|
| Production | The top level | The custom domain, `PUBLIC_URL`, `FRONTEND_URL` (where emailed links point), `ALLOWED_ORIGINS`, the sender address, rate-limit bindings, and log destinations |
| Pull request previews | `env.preview` and its `previews` block | [Worker Previews](https://developers.cloudflare.com/workers/previews/) of a separate Worker, each with its own empty storage |

> [!WARNING]
> Previews are public. They email only addresses in `EMAIL_ALLOWLIST`, which takes full addresses and `@domains`.

## Set the signing key

The only secret is `JWT_PRIVATE_KEY`, plus `JWT_PRIVATE_KEY_PREVIOUS` while you [rotate it](#rotate-the-signing-key). Every token key and log reference key is derived from it with HKDF, so any long random secret works. A P-256 private key in PKCS#8 PEM works too.

```bash
npx wrangler secret put JWT_PRIVATE_KEY
npx wrangler deploy --env=""
```

### Rotate the signing key

Only the API uses the key, so nothing else needs updating. Tokens made with the old key keep working while it's in `JWT_PRIVATE_KEY_PREVIOUS`, so nobody is signed out.

1. Put the current key in `JWT_PRIVATE_KEY_PREVIOUS`. Cloudflare can't show a secret again, so use the copy you keep.

   ```bash
   npx wrangler secret put JWT_PRIVATE_KEY_PREVIOUS < current-key.txt
   ```

2. Put a new key in `JWT_PRIVATE_KEY`.

   ```bash
   openssl rand -base64 48 | npx wrangler secret put JWT_PRIVATE_KEY
   ```

3. After 30 days, the longest a session lasts, delete the previous key.

   ```bash
   npx wrangler secret delete JWT_PRIVATE_KEY_PREVIOUS
   ```

After the switch:

- Every `party.ref` in the logs changes, so you can't follow a party's requests across it.
- The per-address email limit starts over. It only counts over a minute anyway.

If you don't have the current key (it's lost, or it leaked and must be retired at once), skip step 1. This signs everyone out and voids every emailed link and live ticket.

## Continuous integration

Workflows live in `.github/workflows/`.

1. Every pull request runs the checks, deploys as a Preview, and smoke-tests it.
2. `main` deploys to production.

**Permissions.** Pull request jobs get a token that can only edit the preview Worker. The production token is limited to deployments from `main`.

**Supply chain.** Third-party actions are pinned to commit SHAs. Dependabot proposes action and npm updates weekly, a week after each release.

## Encrypted tokens release

The API and the web app shipped encrypted tokens together. In the same release, the app stopped reading tokens and started binding sessions at sign-in.

- Tokens issued before that release stopped working, so everyone signed in once.
- Older emailed links stopped working.

## Bound sessions

`REQUIRE_BOUND_SESSIONS` is on, so production and previews accept only [bound sessions](security.md#bound-sessions-dpop). The web app has bound every sign-in since its #220. A session from before then gets one `401`, and its owner signs in again.

### Check bound sessions after a deploy

Smoke checks can't sign in, because they have no mailbox. After a deploy that touches sessions, check by hand:

1. Sign in on gnomik.me.
2. Open a party.
3. Roll the dice in a test party.

The smoke checks do cover the headers the app needs: `dpop` allowed in requests, and `DPoP-Time` readable in responses.

### Turn off bound sessions

If you see a `401` after a deploy, the proofs' URL probably doesn't match what the Worker sees on that host. To accept unbound sessions while you fix it:

1. Set `REQUIRE_BOUND_SESSIONS` to `"false"` in `wrangler.jsonc`.
2. Redeploy.

## Maintain production data

`scripts/data.ts` works on production data through the Cloudflare API's Durable Object SQL endpoint. It needs an API token with Workers Scripts Write.

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
```

| Command | What it does |
|---|---|
| `node scripts/data.ts count` | Counts drawn and open parties. The drawn count is the Party'o'meter's starting point. |
| `node scripts/data.ts tidy` | Shows what clean-up would change. |
| `node scripts/data.ts tidy --apply` | Applies the clean-up. |
| `node scripts/data.ts wake` | Starts every open party once. Run it after the auto-prune deploy. |

### Start auto-prune

Parties nobody opens never start on their own. After the deploy that introduces auto-prune, run `wake` once:

1. Each open party starts and gets its prune date from its last activity.
2. A party that went quiet before `AUTO_PRUNE_SINCE` (in `src/do/PartyDO.ts`) is erased by its alarm, with no email. Keep `AUTO_PRUNE_SINCE` no later than the deploy day.
3. Run `count` to see which parties are still open.

### Set the Party'o'meter's starting count

The Party'o'meter starts from `ROLLED_BEFORE_COUNTER` in `src/do/StatsDO.ts` (29, counted on 2026-10-26). Recount with `count` right before the first deploy.

## How data moves

- `PartyDO` writes changes that other objects need, such as members' party lists and draw emails, to an **outbox** in the same transaction. The outbox delivers them with retries.
- An alarm deletes open parties after 45 days without activity, and erases deleted parties once they can no longer be restored.

## Monitor the API

Logs (`console.*` and Cloudflare's request logs) and traces go to Workers Logs. You can export them over OpenTelemetry through the destinations in `wrangler.jsonc`.

Every route runs in a span named `api.<action>`, such as `api.createParty`, `api.joinParty`, or `api.lookUpParty`. Spans carry these attributes:

| Attribute | Description |
|---|---|
| `api.status`, `api.error_code` | The outcome |
| `party.ref` | The party, as an HMAC of its code |
| `rate_limit.hit` | The limit that refused the request |

Spans also carry the action and the internal user ID, and Durable Object calls show up as child spans.

An unexpected error returns `500` with an `errorId`. The same ID is logged with the error, under the message `Unhandled error`.

## Run the tests

| Command | What it covers |
|---|---|
| `npm run test:unit` | Every module directly. Requires 100% coverage of lines, branches, functions, and statements, with the report in `coverage/`. Also pins how many Durable Object calls each route makes, and checks that lists and parties cost the same however much they hold (`test/unit/efficiency.test.ts`). |
| `npm run test:integration` | Every flow end to end, through the Worker's real entry point, following links in emails the way a person would. Email goes to a test mail sink (`test/integration/mail-sink.js`). |
| `npm run smoke` | Read-only checks against a deployed API. Set `SMOKE_URL=https://...`. |
