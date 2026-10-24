# Migration plan: AWS Lambda + Express + MongoDB Atlas → Cloudflare Workers + Hono + Durable Objects

Status: Phases 1 and 2 are implemented on the `cf-migration` branch (see "Implementation status" at the end). Phase 0 checks, the deploy to workers.dev and cutover are still to do.

## Goals

1. Replace Express with Hono, keeping Apollo Server 4, through a small adapter we own.
2. Replace the AWS Lambda / API Gateway / CloudFormation stack with a Cloudflare Worker at `api.gnomik.me`.
3. Replace MongoDB Atlas with Durable Objects (SQLite storage), and migrate the existing data.
4. Replace SendGrid with Cloudflare Email Service (Workers `send_email` binding).
5. Survive a sudden traffic spike (the "Reddit effect") without a single bottleneck.

Non-goals: changing the GraphQL schema, the magic-link flow, or the wording and look of the emails. The frontend should not notice, apart from Party node ids changing format once at cutover (see Data model).

## Decisions

| Topic | Decision | Why |
|---|---|---|
| HTTP framework | Hono | Fetch-native, runs on Workers without Node shims. Our Express layer is ~85 lines. |
| GraphQL | Apollo Server 4 via a small adapter around `server.executeHTTPGraphQLRequest` | No third-party integration risk. Schema, resolvers and `graphql-middleware` stay. |
| Datastore | Two Durable Object classes with SQLite storage: one `PartyDO` per party, one `UserDO` per user | Scales horizontally: every party and user is its own object, so there is no global bottleneck. Each party's join, leave and close are real transactions. KV was rejected: it is eventually consistent, has no transactions and no queries. |
| Lookups | `PartyDO` is addressed by slug and `UserDO` by lowercased email, both with `getByName()` | Gives slug and email uniqueness for free, without separate index objects. |
| Cross-object writes | `PartyDO` is the source of truth. Changes to users go through a transactional outbox in `PartyDO`, delivered by its alarm to idempotent `UserDO` methods | A membership change and its follow-ups commit together and are retried until delivered, so the two sides always converge. |
| Mail | Cloudflare Email Service via the `send_email` binding (`env.EMAIL.send`) | No API key or SDK, native to Workers. It has no hosted templates, so the two SendGrid templates are re-created as render functions in the repo. |
| Errors and logs | Better Stack via Cloudflare's OpenTelemetry export (Sentry removed) | No SDK in the Worker: Cloudflare exports logs and traces to Better Stack. Unhandled errors are logged with an `errorId` that is also returned to the client. |
| JWT | `jose`, ES256 with `JWT_PRIVATE_KEY` (a new P-256 key) | The frontend verifies tokens in the browser, so it holds the matching public key (in its `src/config.json`) and verifies ES256. HS256 was tried first and broke sign-in on the frontend; the old RSA pair was replaced at the same time. |
| Abuse and spikes | Workers rate-limiting binding on `enterRequest`, per IP and per email | `enterRequest` is unauthenticated and sends mail to any address. A spike also brings abuse that would burn the email quota. Turnstile is deferred: add it only if abuse shows up, since it needs a frontend change. |

Fallback: if Apollo 4 does not run cleanly under Hono in the spike, switch to `graphql-yoga`. The schema and resolvers carry over either way.

## Data model

```
Worker (Hono + Apollo, stateless)
  ├─ env.PARTY.getByName(slug)   → PartyDO   (one per party)
  └─ env.USER.getByName(email)   → UserDO    (one per user)
```

### `PartyDO` (name: party slug, e.g. `QWERT`)

SQLite tables:
- `party`: one row with `id` (ObjectId hex, kept from Mongo or newly generated), `name`, `password`, `slug`, `host_id`, `is_closed`, `created_at`.
- `memberships`: `member_id` (primary key), `member_email` (null for the legacy users without email), `name`, `target_id`, `target_name`, `joined_at`.
- `outbox`: `id`, `kind` (`user.addParty`, `user.removeParty`, `user.setName`, `mail.partyNotification`), `payload`, `attempts`, `next_attempt_at`.

Methods:
- `create(input)`: fails with a conflict if the party is already initialised. That conflict is the atomic slug claim. The caller retries with a new slug.
- `view(userId)`: returns everything `partyEntityToNode` needs in one call (isHost, isJoined, participants, count, target).
- `join(user, name, password)`, `leave(userId)`, `close(hostId)`: each runs in one `transactionSync`. It checks the rules, writes the change, adds outbox rows, and sets the alarm to fire immediately.
- `alarm()`: delivers pending outbox rows (normally within milliseconds), retries failures with exponential backoff, and deletes rows once delivered.
- `importParty(snapshot)`: idempotent, used by the migration.

Notes:
- `participantCount` is `COUNT(*)` on `memberships`.
- `close` runs the shuffle and writes every target in one transaction, then queues one `mail.partyNotification` row per participant with an email. Emails come from `member_email`, which is copied at join time, so there's no fan-out to `UserDO`s. The shuffle is a small Fisher–Yates function, replacing `lodash`.
- The outbox is the only path to `UserDO`s. There is no separate inline call.

### `UserDO` (name: lowercased email)

SQLite tables:
- `user`: one row with `id` (ObjectId hex), `email`, `name`, `joined`.
- `parties`: `slug` (primary key), `name`, `created_at` (the user's party list, for the `parties` query).

Methods:
- `ensure()`: get or create the user. Atomic, so two simultaneous logins can never create duplicate users.
- `get()`, `addParty(slug, name, createdAt)`, `removeParty(slug)`, `setName(name)`: all idempotent, so outbox retries are safe.
- `listParties(first)`: newest first.
- `importUser(snapshot)`: idempotent, used by the migration.

The 4 legacy users without an email (old Facebook logins) get no `UserDO`: they can never sign in, so nothing would read it. Their memberships stay in the parties, so other participants still see them. Outbox rows for them are skipped.

### Ids and tokens

- **User node ids are unchanged:** `base64("User:<objectId>")`. They must not contain the email, because `target.id` is shown to other participants.
- **Party node ids change to `base64("Party:<SLUG>")`**, so the Worker can find the `PartyDO` from a node id without an index. `strToNodeId` stops requiring an ObjectId for parties. Old Party ids stop working after cutover, which is fine: old ids don't need to survive. Party URLs (`/p/<SLUG>/`) keep working, because slugs are kept.
- **The session JWT carries `sub`** (the User node id) **and `email`** (the `UserDO` name), so `authMiddleware` can reach the user's object without a lookup. Only the token's owner sees it.
- **New ids are generated as ObjectId-compatible hex**, 24 characters with a leading timestamp, so they sort by creation time like Mongo's.

### How each operation maps

| Operation | Calls |
|---|---|
| `enterRequest` | rate-limit check, sign the magic-link token, send the email inline |
| `enter` | `UserDO(email).ensure()` → issue the session token |
| `user` | `UserDO(token.email).get()` |
| `party(code)` | `PartyDO(code).view(userId)` |
| `parties(first)` | `UserDO(token.email).listParties(first)` → `PartyDO(slug).view(userId)` for each, in parallel |
| `createParty` | generate a slug → `PartyDO(slug).create(...)` (retry on conflict) → outbox `user.addParty` |
| `joinParty` | `PartyDO(slug).join(...)` → outbox `user.addParty` and `user.setName` |
| `leaveParty` | `PartyDO(slug).leave(...)` → outbox `user.removeParty` |
| `closeParty` | `PartyDO(slug).close(...)` → outbox mail rows, sent by the alarm |

## Code changes

| Today | After |
|---|---|
| `src/index.ts` (Express app, Sentry, morgan, helmet, cors) | Hono app: `/`, `/graph`, `cors`, `secureHeaders`, error handler. Exports the Worker `fetch` and the DO classes. |
| `src/lambda.ts`, `webpack.config.js`, `sam-template.yaml` | removed. `wrangler.jsonc` replaces them. |
| `src/utils/express`, `src/express.d.ts` | removed. The `X-Developed-By` and `X-Powered-By` headers move to a Hono middleware. |
| `src/apollo/context.ts` `makeContext({ req })` | `makeContext(c)`: reads `Authorization` from `c.req`, takes bindings and secrets from `c.env`. |
| `ctx.db.collection(...)` in resolvers and mutations | typed DO RPC calls, about one per operation (see the table above) |
| `src/models.ts` (ObjectId types) | plain string ids, plus the SQL schemas for the DOs |
| `src/utils/strings/nodeId.ts` (always parses an ObjectId) | the id part is a string. Parties use the slug, users keep the ObjectId hex. |
| `src/utils/santaShuffle.ts` + `lodash.shuffle` | `santaShuffle` with a small Fisher–Yates shuffle. `lodash` removed. |
| `src/utils/jwt.ts` (`crypto`, `Buffer`, RS256) | `jose.SignJWT` with HS256 and `JWT_SECRET`. Keep the `t` header for the token type. Set `iss`, `iat` and `exp` through jose. |
| `jwtVerify` with the RSA private key | `jose.jwtVerify` with `issuer: 'api.gnomik.me'` and `algorithms: ['HS256']`, plus a check that `t` matches the expected token type, so a magic-link token can't be used as a session token. |
| `@sendgrid/mail` and `config.json` `sendgridTemplates` | `src/mail/` with `renderSignIn({ magicLink })` and `renderPartyNotification({ party })` returning `{ subject, html, text }`, and `sendMail(env, to, message)` using `env.EMAIL.send`. The `from` block in `config.json` is reused. |
| `tsconfig.json` (`module: commonjs`) | ESNext modules, `@cloudflare/workers-types`. Check that wrangler's bundler resolves the `src/...` imports via `baseUrl`. |

Dependencies removed: `mongodb`, `bson`, `lodash`, `express`, `body-parser`, `cors`, `helmet`, `morgan`, `@codegenie/serverless-express`, `@sendgrid/mail`, `@sentry/node`, `@sentry/integrations`, `@sentry/webpack-plugin`, `webpack*`, `ts-loader`, `ts-node`, `nodemon`, `dotenv`, `crypto-js` (if unused), `cross-var`.
Dependencies added: `hono`, `wrangler`, `@cloudflare/workers-types`, `@sentry/cloudflare`, `vitest`, `@cloudflare/vitest-pool-workers`.
Kept: `@apollo/server`, `graphql`, `@graphql-tools/schema`, `graphql-middleware`, `jose`, `yup`.

## Apollo adapter (sketch)

```ts
app.all('/graph', async (c) => {
  let body: unknown;
  if (c.req.method === 'POST') {
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  }
  const server = await getServer();            // memoised per isolate
  const res = await server.executeHTTPGraphQLRequest({
    httpGraphQLRequest: {
      method: c.req.method,
      headers: new HeaderMap(c.req.raw.headers),
      search: new URL(c.req.url).search,
      body,
    },
    context: async () => makeContext(c),
  });
  // Apollo returns a chunked body only for incremental delivery; we do not use it.
  if (res.body.kind !== 'complete') return c.text('Unsupported response', 500);
  return new Response(res.body.string, { status: res.status ?? 200, headers: Object.fromEntries(res.headers) });
});
```

`HeaderMap` comes from `@apollo/server`. About 30 lines in total.

## Phases

### Phase 0: Checks before building
- Collect every GraphQL operation the frontend sends from the frontend repo. These become the contract tests.
- Check which Cloudflare plan features are needed: SQLite Durable Objects, Email Sending and the rate-limiting binding. Check the Email Sending daily quota and ask for an increase sized for a spike.
- Onboard `gnomik.me` for Email Sending (`npx wrangler email sending enable gnomik.me`). SendGrid isn't sending anything, so replace its SPF include and DKIM records with Cloudflare's rather than merging them. Add DMARC if missing.

### Phase 1: Worker and Durable Objects
1. **Adapter spike (go / no-go, about half a day).** Branch `cf-migration`. Add `hono`, `wrangler` and `wrangler.jsonc`. Hono app with `/` and the Apollo adapter at `/graph`, using the real schema and middleware and a stubbed data layer. Prove `wrangler dev` serves an introspection query and a JWT-authenticated `user` query. Check bundle size and cold start. If Apollo 4 misbehaves, switch to Yoga before going further.
2. `PartyDO` and `UserDO` with their SQLite schemas, migrations (`new_sqlite_classes`), the outbox and the alarm.
3. Port `enterRequest`, `enter`, `createParty`, `joinParty`, `leaveParty`, `closeParty` and the `party`, `parties` and `user` resolvers, following the operation table.
4. Port JWT to `jose` (HS256), mail to Cloudflare Email Service, Sentry to `@sentry/cloudflare`.
5. Secrets: `JWT_SECRET`, `SENTRY_DSN`, and the admin import secret for Phase 2. `RSA_PRIVATE_KEY` and `SENDGRID_API_KEY` are dropped. The email binding needs no secret.
6. Rate limiting: the Workers rate-limiting binding on `enterRequest`, per IP and per email.
7. Email:
   - Add `"send_email": [{ "name": "EMAIL" }]` to `wrangler.jsonc` (with `"remote": true` for local dev), and run `wrangler types`.
   - Re-create both templates as HTML and plain-text render functions from the exports in `docs/sendgrid-export/`. Sign-in uses `{{magicLink}}` and the static subject "Sign in to Anonymous Ded Morozes". The party notification uses `{{party.name}}` (also the subject) and `{{party.url}}`.
   - Drop the party notification's SendGrid unsubscribe links (`{{{unsubscribe}}}`, `{{{unsubscribe_preferences}}}`).
   - Both templates load images from SendGrid's CDN over plain `http://`. Host copies on our own domain (Workers static assets or R2) over `https://` before SendGrid is closed.
   - Fix the "sing in" typo in the sign-in preheader, and point "Terms and Conditions" at `https://gnomik.me/terms/`.
   - Party-close notification: one email per participant, never a shared `to`, so addresses aren't exposed to each other. Sent from the `PartyDO` outbox with retries on `E_RATE_LIMIT_EXCEEDED`, `E_DELIVERY_FAILED` and `E_INTERNAL_SERVER_ERROR`. `E_RECIPIENT_SUPPRESSED` is logged and skipped.
   - Magic-link email is sent inline in `enterRequest`, since the user is waiting. A send failure is returned as a user error.
8. Tests with `@cloudflare/vitest-pool-workers`:
   - join, leave, close (shuffle and targets), slug conflict and retry, concurrent `ensure()` for the same email
   - outbox delivery and retry, including a failing `UserDO` call
   - token types (magic-link vs session)
   - mail rendering through a fake `EMAIL` binding (recipients, subject, link, both `html` and `text`)
   - contract tests: the frontend's operations from Phase 0 against the Worker

### Phase 2: Data migration
- `scripts/export-mongo.ts` (Node, `mongodb` driver) reads `User`, `Party` and `PartyMembership` from the `adm` database and writes a JSON snapshot to a gitignored folder. Keep a copy of the snapshot somewhere safe outside the repo (it contains emails). It is the backup once Atlas is deleted.
- Transform rules:
  - Map `PartyMembership.target.member` to `target_id` and keep `target.name`. All 174 stored targets use `{ member, name }`. The current reader expects `target.user`, so this also fixes the broken target id on closed parties.
  - Copy each member's email onto their membership row (`member_email`).
  - Keep party and user ObjectIds as hex strings. Build each user's party list from their memberships.
  - Skip `UserDO`s for the 4 users without an email. Their memberships are kept.
  - Drop the legacy `profiles` field (Facebook ids).
  - `participantCount` is not imported, since it's derived.
- Temporary admin import endpoint on the Worker, protected by a secret header. It calls `UserDO.importUser` and `PartyDO.importParty` (both idempotent, so the import can be re-run) and returns the counts it imported, which are compared with the snapshot's counts.

Atlas findings (database `adm`, read-only inspection on 2026-10-24):
- 90 users, 36 parties (29 closed, 7 open), 179 memberships, from 2019-12 to 2024-12.
- Clean data: no duplicate emails or slugs (all uppercase), no duplicate memberships, no orphans, every `participantCount` matches, and all closed parties have a target on every membership.
- 4 users have no email (old Facebook logins): one hosts a party, and together they have 7 memberships.
- 22 parties have a password. They are shared secret phrases the host can read back in the UI, so they stay as they are.

### Phase 3: Test on workers.dev and cutover
The service is not in use, so there's no write freeze, no delta import and no rollback period. `workers.dev` is the test environment.
1. Deploy to `workers.dev`. Run the import and compare the counts. Test with the real frontend.
2. Send test mail to real Gmail and Outlook inboxes and check SPF, DKIM and DMARC pass.
3. Optional load test with k6 or similar: a spike of party views, joins and sign-ins, with the rate limits in place and mail limited to test addresses.
4. Cutover: set `JWT_SECRET` with `wrangler secret put` (random, 32+ bytes), point `api.gnomik.me` at the Worker (custom domain), and remove the API Gateway mapping.

### Phase 4: Decommission and cleanup
Right after cutover:
- Delete the CloudFormation stack, the `gnomik-builds` bucket and the Atlas cluster (the snapshot from Phase 2 is the backup).
- Remove the admin import endpoint and its secret.
- Close SendGrid: revoke the API key that was exposed during this session, delete the templates and the account. Its DNS records were already replaced in Phase 0.
- Delete the read-only Atlas user if the cluster is kept for any reason.
- Replace `.github/workflows/deploy.yml` with a `wrangler deploy` workflow (`cloudflare/wrangler-action` with a scoped API token). Remove the AWS secrets from the repo.
- Update `README.md` and `.env.sample`.

## Risks

| Risk | Mitigation |
|---|---|
| Apollo 4 does not run well on Workers | Adapter spike first. Fall back to `graphql-yoga`. |
| Email quota runs out during a spike, so nobody can sign in | Raise the quota in Phase 0. Rate limiting stops abuse from eating it. |
| `enterRequest` used to spam arbitrary addresses | Rate limiting per IP and per email. Add Turnstile if abuse shows up. |
| A `UserDO` misses a party change (party list or name out of date) | `PartyDO` is the source of truth. The transactional outbox retries until delivered, and the `UserDO` methods are idempotent. |
| Email deliverability is poor on a fresh sender | Test with real inboxes before cutover and watch the Email Service analytics. |
| Token type confusion (magic-link token used as a session token) | Verify the `t` header per use. Unit-test both directions. Keep the 5-minute TTL. |

## Decisions made

- `gnomik.me` DNS is on Cloudflare.
- The service is not in use: no write freeze, no maintenance mode, no rollback period, no suppression list import, and everyone signing in again is fine.
- Test environment is `workers.dev`. There is no separate staging.
- Unsubscribe links are dropped, and the sign-in email links to `https://gnomik.me/terms/`.
- Atlas access is a read-only user with the connection string in `.env.local` (gitignored). Scripts use `client.db('adm')` and never print the connection string.
- Legacy Facebook `profiles` are dropped on import.
- Old ids (node ids, tokens) don't need to survive. All data is kept: users, parties, memberships, targets, party passwords and slugs.
- Data model: one `PartyDO` per party (by slug) and one `UserDO` per user (by email), with a transactional outbox between them.
- Rate limiting now, Turnstile deferred, load test optional. Sentry was later replaced by Better Stack (logs and traces through Cloudflare's OpenTelemetry export).

## Implementation status

Done on `cf-migration`:
- Worker (Hono + Apollo adapter), `PartyDO` and `UserDO` with the outbox, JWT on `jose`, Cloudflare Email Service templates, rate limiting, temporary import endpoint.
- `scripts/export-mongo.ts` exported the real data (86 users, 4 legacy users, 36 parties, 179 memberships) and `scripts/import.ts` imported it into a local `wrangler dev`. Counts match, re-runs are idempotent, and all 165 members of closed parties who have an email see their correct target and party list through the API.
- Tests (vitest with `@cloudflare/vitest-plugin`): 83 unit tests with 100% coverage required (istanbul) and 61 integration scenarios that run end to end through the Worker in local workerd, with a mail sink standing in for Email Service. CI runs the typecheck and both suites on every push and PR; the deploy workflow runs CI, deploys, then smoke-tests the deployment (`scripts/smoke.ts`).
- Email images are served by the Worker from `public/email/` at `PUBLIC_URL`.

Differences from the plan:
- Apollo Server 5 instead of 4 (4 is end-of-life). The adapter API is the same.
- npm (with `package-lock.json`) instead of yarn. Yarn 1 and npm 10 fail to resolve the new dependency set; npm 11 works (the workflow uses `npx npm@11 ci`).
- `closeParty` now requires at least two participants. Before, a one-person party could be closed and produced a broken draw.
- Logging: Sentry was removed. Logs and traces go to Workers Logs and Better Stack; unhandled errors carry an `errorId`.
- The `api.gnomik.me` custom domain is not in `wrangler.jsonc` yet, so a deploy only goes to workers.dev. The deploy workflow is manual until cutover.

Still to do: Phase 0 (frontend operations from santa-barbara for contract tests, plan features and email quota, `gnomik.me` email onboarding), deploying to workers.dev with `JWT_SECRET` and `ADMIN_SECRET`, the import there, testing with the frontend, cutover and cleanup.
