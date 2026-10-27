# Plan: keep less data, traffic spikes, Party'o'meter, safer sessions

Status, checked against branch `keep-less-meter-sessions` on 2026-10-27 (uncommitted since `ae9a85d`; 302 unit tests at 100% coverage and 172 integration tests pass). The API side of every section is built; what's left is the web app, and the deploy steps.

| Part | State | Differences from this plan |
|---|---|---|
| 1. Keep less | Built | `tidy()` runs when the party starts and after each outbox run, not only in `alarm()`. `scripts/data.ts tidy` is written, not yet run with `--apply`. |
| 2. Traffic spikes | Built | The WebSocket backoff (web app) and the Better Stack alert (ops) aren't done. |
| 3. Party'o'meter | Built (API) | The row is seeded when the object starts. The odometer (web app) isn't done. |
| 4.1 Lookup | Built (API) | `GET /v1/parties?code=` is gone. The party's live socket takes its code from the ticket (`POST /v1/live/ticket {code}`), and tickets last 5 minutes. Keeping tickets in `sessionStorage` is web app work. |
| 4.2 JWE | Built (API) | The sealed `em` claim and `SEAL_TOKEN_EMAIL` are gone. Two details the plan didn't name: the bearer check now expects a five-part `dir` JWE, and the key derivation reads `JWT_PRIVATE_KEY` with escaped line breaks as real ones, so it doesn't matter how the secret was stored. The web app changes aren't done. |
| 4.3 DPoP | Built (API) | Each proof also works only once (Review fixes, item 3). Launch condition 1: the integration helper signs in with a key and sends a proof on every request; the deployed-host check is planned (round 2, item 3). Conditions 2 and 3 (web app) aren't done. |
| 5. Auto-prune | Built | `AUTO_PRUNE_SINCE` is 2026-10-27 and must not be later than the deploy day. The host's party list also keeps each party's `restorable_until` (a new `UserDO.parties` column), so the list shows the 7-day deadline too. The email's subject is "‹name› was put away". `scripts/data.ts wake` is written, not yet run. |
| 6. Nothing stored before the click | Built | `ENTER_RATE_LIMIT_EMAIL` is renamed `MAIL_RATE_LIMIT_ADDRESS`, keyed by `mailRef`. The in-memory record of repeat sign-in requests is keyed per address and claimed before the email goes out (released if it fails), so simultaneous repeats send one email. A repeated email-change request is still answered from the requester's own `mail_requests`, which stores nothing for the new address. `mail_sent` is dropped when an object starts. |
| Review fixes 1–6 | Built | |
| Review fixes, round 2 | Built | Item 1 is settled by section 6. The new smoke checks haven't run against a deployed host. |

**Open from the review of the built code:** nothing.

**Still to do:**
- **Web app (santa-barbara), in the same release:**
  - stop reading tokens (4.2) and switch to the lookup;
  - put the party code in the live ticket and keep tickets in `sessionStorage` (4.1);
  - bind sessions with DPoP and recover from a lost key (4.3, launch conditions 2 and 3);
  - the odometer (3), and WebSocket backoff (2).
- **Deploy steps:**
  - recount the rolled parties first (`scripts/data.ts count`);
  - after the deploy: `tidy --apply` and `wake` once;
  - the manual sign-in check, then `REQUIRE_BOUND_SESSIONS` on.
- **Ops:** the Better Stack alert on Durable Object `overloaded` errors.

**Confirmed by integration tests** (`test/integration/`, through the Worker's own entry point with real Durable Objects):

| Plan part | File | What it confirms |
|---|---|---|
| 1. Keep less | `keepLess.test.ts` | Invites kept for a day, then deleted by the next invite or by the alarm. A repeat within a day is skipped, but every invite counts towards the cap, which reads the counter. A draw deletes all invites. Members' emails are cleared once the outbox is empty and kept while anything waits in it, and views, lists, an email change and an account deletion still work by member id. A deleted account keeps no email, and the address signs up again. Expired link records are deleted. |
| 2. Spikes, review fixes 1, 2, 5 | `spikes.test.ts` | Signed-out views are kept, signed-in ones and 404s never are, and they expire. Every party write and an account deletion forget the kept view. The all-emails limit refuses requested emails with 429 and sends nothing. It's taken only for an email about to go out, and invites wait under it without counting against their address twice. |
| 3. Party'o'meter, review fix 4 | `meter.test.ts` | The public count and its headers. A first draw counts once; repeats and refused draws don't. The count is kept in the Worker. Sockets get the count on connect and after a roll, and pings are answered. Only upgrades from the app are accepted, 30 a minute per client. A counter that fails or never answers doesn't hold up or fail a draw. |
| 4.1, 4.2, 4.3, review fix 3 | `sessions.test.ts` | The lookup answers anyone, a member and the host, with its limits, and the GET is gone. A party's socket opens only from a ticket with its code, only for a member; a ticket opens only the socket it's for, is limited like a lookup, and lasts 5 minutes. Tokens are JWE with nothing readable, refused with another type, a changed byte, another key or past expiry; sign-in answers `expiresAt` and `party`; an expired link gives `link_expired` and a fresh one through `magic-link/again`, not past 7 days. A bound session works only with a proof for that key, method, URL (any trailing slash), origin and token, through a whole party, live socket included. A wrong clock gives a 400 with `DPoP-Time`, readable across origins. An optional route treats a missing or bad proof as signed out. An email change binds too, and a malformed key is refused. `REQUIRE_BOUND_SESSIONS` refuses unbound tokens. A proof works once on every route that changes something, a repeat join included, and again on reads, while a fresh proof always works. |
| 5. Auto-prune | `prune.test.ts` | 45 days counted from the last write by a person (create, join, leave, invite, restore; not a lookup). A quiet party is deleted, its host mailed once, the guests' lists drop it, and the host sees the 7-day deadline. It can be restored within the week with 45 fresh days, and is erased after. A host's own delete keeps 24 hours; a drawn party is never pruned. One that went quiet before `AUTO_PRUNE_SINCE` is erased with no email, and an old party nobody opens is erased once the `wake` lookup starts it. |
| 6. Nothing stored before the click | `noStorage.test.ts`, `auth.test.ts` | A magic-link request, an invite and an email-change request to a new address leave no stored object; the account appears when the link is used. About 3 emails a minute per address, by its hash, across sign-in links, invites and email-change links. The email-change notice is never held back. A repeated sign-in request sends one email; a repeated account request is answered from what the account keeps. |

**What the integration tests can't reach, and how they get around it:**
- **Settings are fixed for the whole run** (view cache off, all-emails limit wide open, bound sessions not required). The `settings` option on `call` sends a request through the same app with chosen settings changed. Durable Objects keep the run's own, so a Durable Object setting (the all-emails limit for invites) is swapped on the instance through `runInDurableObject`.
- **Time can't move forward.** Stored times are moved back instead (`ageRows`): invites a day old, expired links.
- **Restarting an object** is done with `evictDurableObject` where a test needs an old object to start again (auto-prune's backfill); the start-up clean-up (`forgetExpired`) is called directly.
- **Worker memory is shared by the whole run,** so a kept view or count outlives a change of settings. Fresh values are read from the objects, and `forgetStats()` clears the kept count.
- **There's no real network.** Requests reach the Worker in-process at `https://api.test`, so the `htu` check is proven against the URL the Worker sees here. Only a smoke run against the deployed hostname covers that hostname.
- **Out of reach:** `scripts/data.ts` (it talks to the Cloudflare API) and the web app's launch conditions 2 and 3.

**Fixed while testing:** a circular import. `PartyDO` and `UserDO` read the live header names from `src/api/live.ts`, which imports `session.ts`, which leads back to `PartyDO` through `schemas.ts`. Loading `session.ts` first left `requireSession` unset, so `POST /v1/live/ticket` answered 404. The header names now live in `src/utils/liveHeaders.ts`, with no imports. Only type-only import cycles remain (through `env.ts`), and those are dropped at runtime.

The API and the web app deploy together, and production has little real traffic, so nothing here needs a transition release.

Scale today (production, counted 2026-10-26): 81 party objects, of which 29 drawn (172 people), 7 open, 11 deleted and erased, and 34 looked up but never stored. The plan is sized for that, with notes on what to add if traffic grows.

1. **Keep less personal data.** Stored data is not encrypted (the reasons are at the end).
2. **Traffic spikes:** two small guards.
3. **Party'o'meter:** a live count of rolled parties `[0][0][0][0][2][9]`.
4. **Sessions in transit:** the party code moves out of URLs, every token is encrypted (JWE), and session tokens are bound to the browser.
5. **Auto-prune:** open parties with no activity for 45 days are deleted, restorable for 7.
6. **Nothing stored before a sign-in link is used.**

---

## 1. Keep less personal data

Data that isn't stored can't leak, to anyone. Every change here is plain SQL in code that already exists: no new secret, no new library.

| Data | Where | Change |
|---|---|---|
| Invited addresses | `PartyDO.invites` | **Keep each address for only 24 hours**: just long enough to skip repeat invites. Delete older rows whenever `invite()` runs and in the alarm. The 50-invite cap moves to a counter column, `party.invites_sent`, backfilled once in `migrate()` as `SUM(sent)`. |
| Invites of a drawn party | `PartyDO.invites` | **Delete all rows at the draw**, in the same transaction. |
| Members' emails in a drawn party | `PartyDO.memberships.member_email` | **Clear them in `alarm()` once the party is drawn and the outbox is empty.** After the draw they're only used to deliver what the draw queued; everything else goes by user id (`view`, `changeMemberEmail`, `forgetMember`). Before shipping, check that nothing can queue a `user.sync` for a drawn party afterwards. |
| Email of a deleted account | `UserDO.user.email` | **Blank it in `tombstone()`**, like the name already is. The goodbye email has its own copy in the outbox, and signing up again replaces the row. |
| Expired link records | `UserDO.used_magic_links`, `mail_requests` | Today they're cleaned up only when that address uses a link again. **Also clean them up when the object starts.** After section 6, `mail_requests` holds only account emails' requests (in the account's own object); sign-in requests no longer write it. |

**Existing data:** objects clean themselves up the next time they start. For objects nobody opens, run the same statements once through the Cloudflare API's Durable Object SQL endpoint (`POST …/durable_objects/namespaces/:ns/query/v2`, the one Data Studio uses), from a short script in `scripts/`. At about 47 party objects plus the user objects, that's one run, and it needs no internal route or admin secret.

**Also:**
- Limit Editor access to the Worker to the people who deploy it. Data Studio queries show up in Cloudflare's audit log.
- Add a short "what we keep" list to the README.
- Note that Cloudflare keeps 30 days of point-in-time history, so removed data lingers there for 30 days.

**Tests:**
- A drawn party has no member emails or invites once its outbox has drained, and views, account deletion and email changes still work.
- The invite cap still counts every invite sent, and a repeat within a day is still skipped.
- A deleted account's record has no email, and signing up again works.
- The DO-call counts in `efficiency.test.ts` don't change.

**Open parties that never get drawn** would keep their members' emails for as long as they exist. Section 5 deletes them after 45 days without activity.

---

## 2. Traffic spikes

One Durable Object handles about 500–1,000 simple requests per second and 32,768 hibernated WebSockets. Users and parties each get their own object, so load spreads out on its own. Two paths can still be swamped:

1. **A viral party link** sends every visitor's lookup to one party object. Fix: keep signed-out visitors' view in a small in-memory map in the Worker for 3 seconds, keyed by `partyRef(code)`, and forget it after a write through that isolate (see Review fixes, item 5). That's about 20 lines. Signed-in lookups still go to the object. Don't cache join answers: a member repeating a join gets the party back, and only the object knows who's a member.
2. **No overall cap on sign-in emails**, so a spike or a spam run from many IPs could use up the Email Service quota. Fix: one more Rate Limiting binding with a fixed key, for example 60 a minute. It counts per Cloudflare location and only roughly, so it's a backstop, not an exact cap. That's enough at this size. If abuse ever gets past it, add an exact counter in a Durable Object.

Also: reconnect WebSockets with jittered backoff in the web app, since a deploy drops every socket at once. And set a Better Stack alert on Durable Object `overloaded` errors.

---

## 3. Party'o'meter

**`StatsDO`**, a single object (`getByName('global')`) with one row: `stats(rolled INTEGER)`.

- **Counting:** after a draw's transaction, `closeNow` calls `STATS.getByName('global').rolled()` without waiting for it. Repeats of the same draw return earlier and don't count.
  `rolled()` runs `UPDATE stats SET rolled = rolled + 1` and sends `{"type":"stats","rolled":N}` to every connected socket.
  If that call ever fails, one draw goes uncounted. That's fine for a display number, and it keeps the outbox out of this entirely.
- **Starting value:** the first `rolled()` or read creates the row with `SEED = 29`, the count taken on 2026-10-26. Recount right before deploying with the same read-only API query used for this plan. If a draw slips through in between, fix it once through the Data Studio SQL endpoint (`UPDATE stats SET rolled = …`).
- **Reading:**
  - `GET /v1/stats` → `{rolled}`. The Worker keeps it in memory for 10 seconds, so most page loads never reach the object.
  - `GET /v1/stats/live` is a public WebSocket: no ticket, origin checked against `ALLOWED_ORIGINS`, plus a per-IP Rate Limiting binding on upgrades. The object accepts it with the hibernation API, auto-answers `ping`, sends the current value on connect, and ignores anything else.
- **Cost when idle:** nothing beyond the Workers plan. Hibernated sockets and auto-answered pings don't wake the object. Don't use timers in it, since a timer would keep it awake and billed.
- **Setup:** a new wrangler migration tag for `StatsDO` (`new_sqlite_classes`), with bindings at the top level, in `env.preview` and in its `previews` block. Add it to `src/env.ts` and export it from `src/index.ts`.
- **If traffic grows past a few thousand viewers at once:** put sockets on several relay objects that `StatsDO` pushes to. Clients only know the URL, so that change is invisible to them.

**The odometer (santa-barbara):**
- Digit wheels, at least 6 digits. Each changed digit rolls to its new value, and a jump of several rolls through the digits in between. Respect `prefers-reduced-motion`.
- The first value comes from `GET /v1/stats`. The socket is open only while the tab is visible, and reconnects with jittered backoff (1 s → 30 s).

**Tests:**
- A draw counts once, and its repeats don't.
- Sockets receive the new value.
- `GET /v1/stats` makes no Durable Object call when it's cached.
- The origin check and the upgrade limit refuse what they should.

---

## 4. Sessions in transit

TLS already protects the connection. What still leaks is around it: tokens copied into HAR files, logs and storage, and party codes in URLs.

### 4.1 Party code out of the URL

Add `POST /v1/parties/lookup {code}`, with the same answer, rate limits and calls as `GET /v1/parties?code=`, and remove the GET in the same release: the web app switches to the lookup and ships at the same time. This keeps codes out of browser history and proxy logs.

**The party's live socket** carries the code in its live ticket, not in its URL:
- `POST /v1/live/ticket` takes an optional `{ code }` in its body (`bodies.liveTicket`). It runs `admitCode` (the per-IP lookup limits) and puts the code in the ticket as a `party` claim.
- `GET /v1/parties/live?ticket=…` reads the code from the ticket (`liveRequest` returns it) and refuses a ticket without one. `GET /v1/me/live` refuses a ticket that has one. So each ticket opens only the socket it was issued for.
- This relies on 4.2: only an encrypted ticket hides the code.

**Tickets are reused, simply.** Performance and simplicity come before the odd missed live update, since the emails still go out.
- `LIVE_TICKET_TTL` goes from 60 s to 5 minutes. A ticket is checked only when the socket connects, and the socket only ever says "something changed": the app then fetches with its bound session. So a leaked ticket shows only when that party or account changed.
- The web app keeps each ticket in `sessionStorage` (per tab, cleared on sign-out) under `live:me` or `live:<code>`, with its expiry, and reuses it until it expires.
- If a socket is refused, the app drops that ticket and doesn't retry on the spot. The next page load or reconnect fetches a new one. There's no retry or refresh logic beyond that.
- The DO-call budgets don't change: one UserDO call per ticket, now made less often.
- Tests:
  - A ticket with `party` opens only that party's socket, and only for a member. A ticket without `party` is refused there.
  - A party ticket is refused on `/me/live`.
  - `admitCode` limits the ticket route.
  - The ticket works for 5 minutes.

### 4.2 Encrypt every token (JWE)

Today tokens are signed (JWS), so anyone holding one can read what's in it: the email in session tokens and live tickets, and the address, typed address and party code in emailed links. The built version seals only the email (`em`). That is replaced: every token becomes a JWE, so nothing in it can be read outside the Worker.

- **All six kinds** (session token, live ticket, sign-in link, account deletion, email change, email change cancel) are compact JWE: `alg: dir`, `enc: A256GCM`.
  - The 256-bit key is derived from `JWT_PRIVATE_KEY` with HKDF (`info = "token-encryption"`), as `logRef.ts` does. There's no new secret, and rotating the key still signs everyone out.
  - Only the Worker issues and reads tokens, so GCM's authentication does the signature's job, and no JWS is nested inside.
  - The protected header carries the type (`t`), and it's authenticated too.
- **The interface stays:** `src/utils/jwt.ts` keeps `issueToken` and `jwtVerify` (with jose's `EncryptJWT` and `jwtDecrypt`), so callers don't change.
- **Payloads keep a plain `email`, inside the encryption.** This removes `em`, `src/utils/tokenEmail.ts`, `SEAL_TOKEN_EMAIL`, and the `email`/`em` unions in schemas and types.
- **DPoP is unchanged:** `ath` is the hash of the token string, whatever is inside.
- **Web app (santa-barbara), same release:** it can no longer read tokens, so it stops verifying and decoding them. `useJWT`, `publicKey` in `config.json` and `PUBLIC_JWT_PUBLIC_KEY` go.
  - Signed in means it has a stored token, and a 401 signs it out. The sign-in answer gains `expiresAt`.
  - Anything that reads `sub` from the session token (`useCurrentUser`) uses the stored profile's `id` instead.
  - On the sign-in page, `POST /auth/session` returns the link's `party` for the redirect. An expired link gets a `link_expired` error (400), instead of the browser reading `exp`.
  - "Send me a new link" from an expired link calls a new `POST /v1/auth/magic-link/again {token}`. The Worker opens the expired link, if it's at most 7 days past expiry, and emails a new one to the address inside, with the usual limits. The address never reaches the browser.
- **Tests:**
  - Every token kind round-trips, and is refused with another type, a tampered byte, another key, or past its expiry.
  - `link_expired` for an expired sign-in link.
  - `magic-link/again` sends a new link for a link up to 7 days past expiry, and refuses older ones and other token types.
  - The new route gets rows in `revocation.test.ts` (`no session`) and in the call budgets in `efficiency.test.ts`, or the route-registry tests fail.
- **Rollout:** one release, with the web app. Tokens issued before stop working, so everyone signs in once and older emailed links stop working. That's fine at today's traffic.
- **Bound sessions from day one:** every session starts fresh in this release, and the web app binds at sign-in in the same release. So `REQUIRE_BOUND_SESSIONS` can be on at launch, with no 30-day wait. 4.3 says what has to be true first.

**Implementation (4.2):**
- `src/utils/jwt.ts`:
  - **Key:** derived once per isolate. `crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: 'token-encryption' }, …, 256)` over `JWT_PRIVATE_KEY`, cached in a `Map` the way `keyPairFor` is now. `importEcKeyPair` and the ES256 key pair go.
  - **`issueToken`:** `new jose.EncryptJWT(payload).setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ: 'JWT', t: type }).setIssuer(issuer).setIssuedAt()`, plus `setExpirationTime` when there's a `ttl`, then `.encrypt(key)`.
  - **`jwtVerify(token, type, { expiredFor? })`:** `jose.jwtDecrypt(token, key, { issuer, keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'] })`, then the `t` check as now. With `expiredFor`, it passes `clockTolerance` and checks `exp` itself, so `magic-link/again` can open a link up to 7 days past expiry. An expired token still throws jose's `JWTExpired`, so callers can tell it apart.
- **Removed:** `src/utils/tokenEmail.ts` and `test/unit/tokenEmail.test.ts`; `SEAL_TOKEN_EMAIL` from `src/env.ts` and the three `vars` blocks in `wrangler.jsonc`; `emailClaim` in `users.ts` and `live.ts`; `tokenEmail()` in `session.ts` and `live.ts`; the `tokenEmail` union in `schemas.ts` and `TokenEmail` in `types.ts`. `tokens.user` and `tokens.liveTicket` go back to plain objects with `email`, and `UserToken` keeps `cnf`.
- `src/api/errors.ts`: `link_expired: 400` in `ERROR_STATUS`. `POST /auth/session` (`routes/auth.ts`) answers it when `jwtVerify` throws `JWTExpired`, and `invalid_link`/`link_used` as now otherwise.
- `src/api/schemas.ts`: `session` becomes `{ userToken, user, expiresAt, party }`. `expiresAt` is an ISO time, and `issueSession` returns `now + SESSION_TTL`. `party` is the sign-in link's party code or null; the email-change confirm always gives null.
- **`POST /v1/auth/magic-link/again`** in `routes/auth.ts`, body `bodies.link`:
  - It opens the token as `EnterRequest` with `expiredFor: 7 days`, then sends a new link to its `email`, keeping `typed` and `party`.
  - The send is factored out of `POST /magic-link` into one `sendSignInLink(c, { email, typed, party })`, so the limits, the party check and the answer (202) are the same.
- **Tests:**
  - A new `test/unit/jwt.test.ts`: round trip for each type; refused with another type, a changed byte, another key, or past expiry; `expiredFor`.
  - `test/unit/helpers.ts` keeps issuing through `jwt()`, so most tests don't change. Tests that decode tokens to read claims switch to `jwt().jwtVerify`.
- **santa-barbara:** `src/components/hooks/useJWT.tsx` goes. `useCurrentUser.tsx` keeps the token as an opaque string and takes the id from `profile.id`. `EnterContainer.tsx` takes `party` from the `enter` answer, shows the expired screen on `link_expired`, and "send a new link" calls `magic-link/again` with the old token. `publicKey` and `issuer` leave `src/config.json`, and `JWT_PUBLIC_KEY` leaves `src/api/client.ts`.

### 4.3 Bind session tokens to the browser (DPoP, RFC 9449)

A copied session token (from a HAR file, a log, or a copied header) works for 30 days. With binding, it doesn't work without a key that stays in the browser.

- **Web app:** at sign-in, make a non-extractable ECDSA P-256 key pair and keep it in IndexedDB.
  - Send the public key with `POST /auth/session` and `POST /me/email-change/confirm` (the only two places that issue session tokens), as a new strict `key` field.
  - On every API request, send a `DPoP` proof signed with that key: `htm`, `htu` (origin and path, trailing slash removed), `iat`, `jti`, and `ath` (the token's hash).
- **API:**
  - Bound tokens carry `cnf.jkt`, the key's thumbprint.
  - `authenticate` checks the proof with `jose` (`EmbeddedJWK`, `calculateJwkThumbprint`): the signature, the thumbprint, the method and URL, the token hash, and that `iat` is within 60 seconds. That's about 0.1 ms.
  - A missing or bad proof → 401.
  - A wrong clock → 400 with a `DPoP-Time` header, and the web app retries once with the corrected time. Otherwise a laptop with a wrong clock would be signed out on every request. This differs from the RFC, which uses a 401 plus a nonce; the 401 rule matters more here.
  - `optionalSession` treats a bad proof as no session.
  - Add `dpop` to the CORS headers that requests may send, and `dpop-time` to the ones the browser may read.
- **Rollout:** enforcement is on from launch, in the same release as 4.2 (all sessions start fresh then), with three conditions first:
  1. **Tested end to end:** the integration helper (`test/integration/support.ts`) makes a key, signs in with it and sends a proof on every request (done). On the deployed host, the smoke script checks the headers and a person signs in once after the deploy (round 2, item 3), since the smoke script can't sign in.
  2. **The app recovers from a lost key:** when its key is gone (site data cleared, or a new browser profile), it drops the token and asks the person to sign in again, which makes a new key. On a 401, it does the same, never a retry loop.
  3. **The app says when it can't keep a key:** if the browser can't create or store a non-extractable key (no IndexedDB, or a locked-down private window), it shows "This browser can't keep you signed in" instead of a sign-in that fails on every request.
- **Kill switch:** `REQUIRE_BOUND_SESSIONS` is a variable, so turning it off is a one-line change in `wrangler.jsonc` and a redeploy, with no code change. Bound tokens keep working when it's off, and unbound ones work again.
- **Not covered:** XSS or a malicious extension can still act while the page is open. They just can't take the token away to use later.
- **Tests:**
  - 401 for: a missing proof, another key, another method, URL or token, and an unbound token after enforcement.
  - 400 with `DPoP-Time` for a wrong clock.
  - `revocation.test.ts` also refuses a valid token without a proof on every signed-in route.
  - The integration helper sends proofs (done). The smoke script checks the DPoP headers on the deployed host.

---

## 5. Auto-prune open parties

A party that stays open (not drawn) with no activity for 45 days is deleted automatically. The host gets an email and can restore it for 7 days; after that it's erased for good, with its members' emails. Parties that were already past that point on the deploy date are erased with no email and no restore.

**Why activity, not age:** a Secret Santa party is often made in early November and drawn around December 20, about 49 days later. Counting from creation would delete it while people are still joining. Counting from the last activity only deletes parties nobody is using.

**Existing parties (production, counted 2026-10-27):** 7 open parties, created between 2019-12 and 2021-12. Each has only its host, and none has been opened since. All 7 go. Nothing else in production is open.

**The rule, in `PartyDO`:**
- **New column `party.prune_at`:** when the party is pruned, 45 days after its last activity.
  - Activity means a write by a person: create, join, leave, invite, and restore. Lookups don't count, so strangers opening a link can't keep a party alive.
  - Each of those writes sets `prune_at = now + 45 days`, in the same transaction as the write.
  - `migrate()` backfills it for parties that don't have it, from their last known activity: the latest of `created_at`, the members' `joined_at` and the invites' `invited_at`, plus 45 days.
- **One place schedules the alarm:** a shared `nextAlarm()` gives the earliest of the outbox retry, the purge, the invite cleanup and `prune_at` (while the party is open and not deleted). `runOutbox` uses it. So does `migrate()` when it ends, so a party that starts for any reason has its alarm set.
- **The alarm prunes:** when `prune_at` has passed and the party is still open and not deleted, the alarm deletes it like the host's own delete:
  - `setDeleted`, which queues the member list updates, so the party leaves members' lists and stops counting towards the host's open-party limit;
  - a new outbox email, `mail.partyPruned`, to the host.
- **The email:** "Your party ‹name› had no activity for 45 days, so we deleted it. You can bring it back until ‹date›", with a link to the party page, where the host already sees Restore. It's a one-time system email like the draw notification, so it stays outside the all-emails cap and the per-address limit.
- **Restore windows differ:** a host's own delete stays restorable for 24 hours, an auto-delete for 7 days. That needs a new column, `party.restorable_until`, set at deletion. `restoreExpired`, `purgeIfExpired`, the purge alarm and the view's `restorableUntil` read it, and fall back to `deleted_at + 24 h` for parties deleted before it existed. `PartyView` carries it, so `schemas.ts` stops adding `RESTORE_WINDOW_MS` itself.
- **Restoring** counts as activity, so the party gets a fresh 45 days and isn't deleted again right away.
- **After the restore window**, the existing purge erases the party. It drops the memberships, which removes the emails, and leaves the `cancelled` tombstone so the code is never reused.

**Erasing the 7 at deploy, with no email:**
- **Which parties:** only those whose backfilled `prune_at` is before `AUTO_PRUNE_SINCE` (the deploy date, a constant). These had already gone 45 days without activity before auto-prune existed. A party created or used shortly before the deploy gets its `prune_at` after the deploy date, so it goes through the normal path, with the email and the 7-day restore.
- **When:** in the alarm, not in `migrate()`. `migrate()` only backfills `prune_at` and schedules the alarm through `nextAlarm()`, so the erase takes the same path as `purgeIfExpired`: erase, tombstone, then `user.partyPurged` to the host's list. The outbox delivers that in the same alarm run, so the host's list is right as well.
- **Waking them:** parties nobody opens never start on their own. So `scripts/data.ts wake` starts each open party once after the deploy, with a signed-out `POST /v1/parties/lookup` for its code, which it reads through the SQL endpoint. Doing it through the party's own code keeps the host's list and the code tombstone right, which raw SQL can't do for the host's list. A moment later, `count` should show 0 open.

**Tests:**
- An open party with no activity is deleted 45 days after its last write. Its host gets one email, and members' lists drop it.
- A join, leave, invite or restore moves the date. A lookup doesn't.
- It's restorable for 7 days and erased after. A restore gives it 45 more days.
- A host's own delete still has 24 hours.
- A drawn party is never pruned.
- **Old parties:**
  - A party whose backfilled `prune_at` is before `AUTO_PRUNE_SINCE` is erased by its first alarm, with no email, and leaves the host's list.
  - A party created a week before `AUTO_PRUNE_SINCE` is not erased quietly. It's pruned with the email at its own date.
- `migrate()` backfills `prune_at` from the last activity, and sets the alarm.
- The DO-call budgets don't change.

**Not included:** a warning email before the deletion. It's easy to add later, for example 7 days before `prune_at`.

---

**Implementation (5):**
- **Constants in `src/do/PartyDO.ts`:**
  - `PRUNE_AFTER_MS = 45 days`;
  - `PRUNED_RESTORE_WINDOW_MS = 7 days`, next to `RESTORE_WINDOW_MS` (24 h);
  - `AUTO_PRUNE_SINCE = Date.UTC(…)`, set to the deploy day.
- **Columns:**
  - `ADDED_COLUMNS.party` gains `prune_at: 'INTEGER'` and `restorable_until: 'INTEGER'`.
  - When `migrate()` adds `prune_at`, it backfills it: `UPDATE party SET prune_at = MAX(created_at, COALESCE((SELECT MAX(joined_at) FROM memberships), 0), COALESCE((SELECT MAX(invited_at) FROM invites), 0)) + ?`. This is the same pattern as the `invites_sent` backfill.
  - `PartyRow` gains both fields.
- **Activity:** a private `touch()` runs `UPDATE party SET prune_at = ?` (now + `PRUNE_AFTER_MS`) inside the transaction of `create`, `joinNow` (both the plain and the checked path), `leaveNow`, `invite`, and `setDeleted(null, …)` (restore).
- **Deleting:**
  - `setDeleted(deletedAt, reservation, restoreFor = RESTORE_WINDOW_MS)` also sets `restorable_until = deletedAt + restoreFor`, or null on restore.
  - `restoreExpired(party)` reads `party.restorable_until ?? party.deleted_at + RESTORE_WINDOW_MS`.
- **Erasing:** the body of `purgeIfExpired` (delete memberships and party, tombstone in `cancelled`, `user.partyPurged` to the host, `disconnect(GONE)`) moves into a private `erase(party)`. `purgeIfExpired` and the quiet prune both call it.
- **Pruning:** a private `pruneIfDue()` runs in `alarm()` right after `purgeIfExpired()`. It acts on an open party that isn't deleted and whose `prune_at` has passed:
  - if `prune_at < AUTO_PRUNE_SINCE`, it calls `erase(party)`, with no email;
  - otherwise it calls `setDeleted(now, undefined, PRUNED_RESTORE_WINDOW_MS)` and queues `{ kind: 'mail.partyPruned', email: hostEmail, partyName, slug, restorableUntil }`.

  The same alarm's `runOutbox` then delivers the list updates and the email.
- **Scheduling:** the next-alarm part of `runOutbox` moves into a private `nextAlarm(): number | null`. It takes the earliest of the outbox retry, `restorable_until` (or the 24 h fallback), the oldest invite + `REINVITE_AFTER_MS`, and `prune_at` while the party is open and not deleted. `runOutbox` awaits `setAlarm(nextAlarm())`. `migrate()` ends with `void this.ctx.storage.setAlarm(...)`, since it's synchronous; the output gate holds the answer until the alarm is stored.
- **The view:** `PartyView` gains `restorableUntil: number | null`, set in `buildView`. In `schemas.ts`, `partyJson` reads it, and the `RESTORE_WINDOW_MS` import goes.
- **The email:** a new outbox kind `mail.partyPruned` in the `OutboxMessage` union. A new template, `src/mail/templates/partyPruned.ts` (like `partyNotification.ts`), with `renderPartyPruned({ party: { name, url }, restorableUntil, assetsUrl })` in `src/mail/index.ts`. `deliver()` sends it the way it sends `mail.partyNotification`.
- **`scripts/data.ts wake`:**
  - For each `PartyDO` with a `party` row that is open and not deleted, it reads `slug` with `SELECT * FROM party`. That's because the 2019–2021 parties lack the newer columns, and naming a missing column fails the whole query.
  - It then sends `POST ${API_URL}/v1/parties/lookup` with `{ code: slug }`, where `API_URL` defaults to `https://api.gnomik.me`. The 7 old codes stay under the legacy-code limit of 10 a minute.
  - Then `count` reports the open ones left.
- **Tests:** a new `test/unit/prune.test.ts`. Dates are set by writing `prune_at` and `created_at` through `runInDurableObject`, and the alarm runs with `runDurableObjectAlarm`. A row for each case in the list above, plus `migrate()` setting the alarm for an old party that has none.

## 6. Nothing stored for a sign-in request until its link is used

Today `POST /auth/magic-link` writes to the user object named by the address before anyone clicks: the request's idempotency record (`mail_requests`) and the per-address count (`mail_sent`). Party invites (`countMail` on the invitee's object) and the new-address check of an email change (`checkRecipient`) do the same for addresses that have no account. Production today (counted 2026-10-27) has 89 user objects, all accounts or tombstones, and none left over from requests that were never used. So there is nothing to clean up, only to stop.

- **A sign-in request writes nothing.** Everything the link needs is inside the encrypted link (section 4.2): the address, the typed address, the party code, the link id and its expiry. The account and the used-link record are written only when the link is used (`POST /auth/session`).
- **One per-address limit:** a Rate Limiting binding, `MAIL_RATE_LIMIT_ADDRESS`, keyed by an HMAC of the address (`mailRef`, derived like `logRef`), so the address itself is never the key. About 3 a minute per address. Sign-in links, invites and the email-change link to the new address all use it.
  - It's the existing `ENTER_RATE_LIMIT_EMAIL` binding, already 3 a minute (namespaces 1002 and 2002), renamed to `MAIL_RATE_LIMIT_ADDRESS` and keyed by the hash instead of the raw address. So there's still one per-address binding, not two.
  - It also replaces the hourly `mail_sent` quota and its `ADDRESS_QUOTA`.
  - This also settles the earlier review finding about the quota being used up by a 429.
- **Never limited per address:** the notice to the current address of an email change ("someone is changing your email", with the cancel link). It's what lets the owner stop a change made with a stolen session, so a burst of change requests mustn't be able to hold it back. It's still sent only for a request that passed the per-IP limit, the session check and the new address's limit. Today's `NOTICE_QUOTA` (`always: true`, counted but never blocking) did the same; with the count gone, the notice is simply sent. The auto-prune email (section 5) and the draw notification are also outside it.
- **Repeats of one request** (same `Idempotency-Key`):
  - For addresses without an account (sign-in links, the email-change link to the new address), they're remembered in the Worker's memory for 2 minutes, like the view cache, not in storage. The busy button (santa-barbara#219) already stops double clicks.
  - Account emails (`/me/deletion`, the notice to the current address of an email change) keep their claim in `mail_requests`, in the account's own object, through `beginMailRequest` as today. That object exists anyway, so nothing new is stored.
- **UserDO creates its tables on first write, not in its constructor,** like `PartyDO.hasSchema`. A read (`get`, `check`, the "is this address taken" check) then never leaves an empty object behind.
- **Tests:**
  - A magic-link request, an invite and a new-address check leave no stored object.
  - The limit counts per address hash, for sign-in links, invites and the email-change link alike, and no binding is keyed by a raw address.
  - The email-change notice to the current address still goes out when that address is over its limit.
  - A repeat of an account email request is still answered from `mail_requests`.
  - A repeated request sends one email.
  - The account appears only when the link is used.
  - The DO-call budgets drop: the magic-link request makes no UserDO call.

**Implementation (6):**
- **`mailRef(env, email)`** in `src/utils/logRef.ts`: HKDF over `JWT_PRIVATE_KEY` with `info = "mail-ref"`, then HMAC-SHA-256 of the canonical address, base64url. It's built the same way as `partyRef`.
- **The binding:** `ENTER_RATE_LIMIT_EMAIL` is renamed to `MAIL_RATE_LIMIT_ADDRESS`, with the same namespaces 1002 and 2002 and 3 a minute, in the three `ratelimits` blocks of `wrangler.jsonc`, in `src/env.ts` and in `test/unit/helpers.ts`. `emailRateLimit` keys it with `await mailRef(env, email)`.
- **`routes/auth.ts`, `POST /magic-link`** (and `sendSignInLink` from 4.2):
  - It drops every UserDO call: `seenMailRequest`, `claimMailRequest`, `countMail` and `releaseMailRequest`.
  - Repeats go to a new `src/api/requestMemo.ts`. It's an in-isolate `Map` of `keyHash(Idempotency-Key)` to `{ detail, until }`, kept for 10 minutes like today's `MAIL_REQUEST_TTL_MS`, and capped at 500 entries like the view cache.
  - The order is: memo check (a repeat answers 202), IP and address limits, party check, then send (`sendRequestedMail`, which takes the all-emails cap). On a failed send, the memo entry is dropped.
- **`routes/me.ts`:**
  - `mailRequest` and `beginMailRequest(session, key, detail)` lose the `quota` argument. They still claim the repeat in `mail_requests`, in the account's own object.
  - `POST /me/deletion` checks the address limit (`emailRateLimit` already does).
  - `POST /me/email-change`:
    - `checkRecipient` is replaced by `USER.getByName(newEmail).get()`. With tables created on first write, that read stores nothing.
    - The address limit is checked for `newEmail` only.
    - The notice to the current address goes out with `sendCourtesyMail`, with no limit.
- **`PartyDO.deliver`, invites:** `countMail(ADDRESS_QUOTA)` becomes `MAIL_RATE_LIMIT_ADDRESS.limit({ key: mailRef })`, taken after the all-emails cap. Over it, the invite is dropped, as with the cap today.
- **Removed:**
  - from `src/api/rateLimit.ts`: `EMAILS_PER_ADDRESS_PER_HOUR`, `ADDRESS_QUOTA`, `NOTICE_QUOTA` and `tooManyForAddress` (the address limit answers with the existing `rate_limited`);
  - from `UserDO`: `MailQuota`, `MAIL_QUOTA_WINDOW_MS`, `takeMailQuota`, `countMail`, `checkRecipient` and `seenMailRequest`;
  - `releaseMailRequest` keeps only the `mail_requests` delete.
  - The constructor runs `DROP TABLE IF EXISTS mail_sent` once, so the old counts go too.
- **UserDO's lazy tables:** the `CREATE TABLE` block, the `ADDED_COLUMNS` loop and `forgetExpired()` move out of the constructor's `blockConcurrencyWhile` into `ensureSchema()`.
  - **Writes:** the methods that can write call `ensureSchema()` first: `ensure`, `redeemMagicLink`, `startAccountChange`, `cancelAccountChange`, `abortAccountChange`, `receive`, `updateName`, `signOutEverywhere`, `tombstone`, `startHosting`, `retargetRequest`, `beginMailRequest`, `releaseMailRequest`, `apply` and `markRevealed`.
  - **Reads:** a `hasSchema()` check (one `sqlite_master` read, remembered, as in `PartyDO`) answers null or empty for an object without tables. That covers `get`, `check`, `checkAccountChange`, `unrevealed`, `listParties`, `pendingOutbox`, `alarm` and the live `fetch` and `webSocketMessage`.
  - `holds()` writes `used_proofs` only after `sessionMatches` passes, which needs an account, and so the tables.
- **Tests:**
  - **No storage:** the no-storage checks read `SELECT COUNT(*) FROM sqlite_master WHERE name NOT LIKE '_cf_%'` through `runInDurableObject`, and expect 0 after a magic-link request, an invite delivery and an email-change request to a new address.
  - **Budgets:** `efficiency.test.ts` sets `'POST /auth/magic-link'` to `USER: 0, PARTY: '0, or 1 with a party code'`.
  - **Existing tests:** the ones built on the hourly cap (`test/unit/mailCap.test.ts`, `test/unit/guards.test.ts`, `test/integration/auth.test.ts`) switch to a `denied` `MAIL_RATE_LIMIT_ADDRESS` from `testEnv`, or a low limit in the integration Miniflare config.

**Decided (2026-10-27):** per-address limiting uses only the Rate Limiting binding keyed by the address hash, about 3 a minute (`MAIL_RATE_LIMIT_ADDRESS`, `simple: { limit: 3, period: 60 }`, the renamed `ENTER_RATE_LIMIT_EMAIL`). Bindings count only over 10 or 60 seconds, so there's no hourly per-address cap any more. Nothing is stored before the click. The per-IP limit and the all-emails cap still apply.

---

## Considered and not planned

- **Encrypting stored data.** Cloudflare already encrypts storage. Anyone who can browse it (Data Studio needs Editor access) can also deploy code that reads any key. Keeping less data (section 1) protects more for far less work. Revisit if a GDPR position on encrypted data becomes a requirement.
- **HPKE body encryption between the web app and the API.** Cloudflare ends TLS and also runs the Worker, so it hides nothing from anyone who isn't already trusted. It doesn't stop an active proxy, which also serves the web app's JavaScript. Token binding (4.3) covers the realistic leaks. Revisit if a separate relay is ever put in front of the API (Oblivious HTTP).
- **Naming user objects by a hash of the email** instead of the email itself.
- **Relays and exact email counters**: deferred until traffic needs them (sections 2 and 3).

---

## Review fixes (2026-10-27)

From the review of the built branch, and built on the same branch. Rollback hazards are out of scope: nothing is in use yet. Building item 3 also turned up an older gap, now fixed: a member repeating a join got their view back without a session check, so a revoked token (after an email change) could still read the party.

1. **Party invites count against the all-emails cap.** In `PartyDO.deliver`, take from `MAIL_RATE_LIMIT_ALL` (key `ALL_MAIL`) before sending a `mail.partyInvite`. When it's refused, throw so the outbox retries later. Don't drop the invite: the host asked for it. Draw notifications and goodbye emails stay outside the cap, since they're only sent once.
2. **Only emails about to be sent use up the all-emails cap.** Move the check out of `emailRateLimit` and into `sendRequestedMail`, the one path every requested email takes. It then runs after the party-code check and the per-address quota, so requests refused for those reasons no longer spend it. `emailRateLimit` goes back to per IP and per address. If the cap is hit, the answer is a 429, not a 503.
3. **A DPoP proof works only once.** The session carries `proof: { jti, request, until }`. `request` is a random id per request, so one request may check its session more than once, and `until` is `(iat + 60 s)`. Every session check in UserDO goes through `holds()`, which records the `jti` in a new `used_proofs` table; a repeat is refused like a revoked token. Rows are deleted on each claim once past `until`, and by `forgetExpired`. `RequestSession.verify()` now calls `UserDO.check(session)` instead of `get()`, and joins pass the proof through `JoinCheck`. Since round 2 (item 5), only routes that change something record the proof. This adds no extra Durable Object calls, and the efficiency budgets stay the same. A proof sent on a signed-out route with no session check isn't tracked, and doesn't need to be. Tests: a replayed proof is refused on every signed-in route; retries with a new proof still work.
4. **A draw doesn't wait for the counter.** `closeNow` calls `this.ctx.waitUntil(this.countRoll())` instead of awaiting it. Tests wait for the count.
5. **The signed-out view cache follows changes.**
   - Any change made through this Worker forgets that party's kept view in the isolate that made it: join, leave, draw, delete, restore and invite in `routes/parties.ts`. So do the parties an account deletion erases (`/me/deletion/confirm`).
   - Other isolates can't be told, so kept views last 3 s instead of 10 s (`PUBLIC_VIEW_MS`; the stats keep 10 s). For a viral link that's still at most one call per 3 s per isolate.
   - Tests: after a draw or delete, a signed-out lookup in the same isolate sees the new state right away.
6. **Names line up.** The `StatsDO.fetch` comment said `/v1/live/stats`; it now says `/v1/stats/live`, like the code, README, plan, tests and smoke script.

---

## Review fixes, round 2

From the second review of the built code. None is serious; each fix is small. Items 2–8 are built on the branch (2026-10-27); item 1 comes with section 6. The smoke checks in item 3 haven't run against a deployed host yet.

1. **A refused email shouldn't use up the address's allowance.**
   - **Today:** a sign-in request without an `Idempotency-Key` counts against the address (`countMail`) before the all-emails cap can answer 429, and nothing gives it back.
   - **Fix:** section 6 removes that hourly count, so this fix is section 6 itself, not a separate patch: nothing is deployed in between.
   - **What's left after it:** the per-address limit is taken before the all-emails cap, so a cap 429 still uses one of the address's 3 a minute. That costs at most a minute.
   - **Test (with section 6):** a sign-in request refused by the all-emails cap leaves the address room for its next request a minute later.
2. **The unit roll-count test waits for the count.**
   - **Fix:** `test/unit/stats.test.ts` checks the count with `vi.waitFor`, as `test/integration/meter.test.ts` does. The same goes for the "counter can't be reached" case, which checks `console.warn` once the background count has run.
   - Nothing else in the unit tests reads the count right after a draw.
3. **Checking bound sessions against the deployed host.** The smoke script can't sign in (it has no mailbox to read the link from), so it can't send a proof against the real hostname. Instead:
   - **Read-only smoke checks:**
     - the CORS preflight from `https://gnomik.me` allows `dpop`;
     - `GET /v1/stats` exposes `dpop-time`;
     - a bound-looking request without a session still answers 401, not 500.
   - **A manual check after the first deploy with binding:** sign in on gnomik.me, open a party, and draw a test party.
     - Any 401 means the URL check doesn't match the host. Turn `REQUIRE_BOUND_SESSIONS` off (the kill switch in 4.3) and fix it.
     - This step goes into the README's deploy notes.
4. **A lookup that overlaps a write can't keep the old view.**
   - **How:** `src/api/viewCache.ts` gains `forgotten`, a `Map` from party ref to the time of its last `forgetView`, pruned like `views`.
     - `lookUp` notes the time before it calls `view()`.
     - `keepView(ref, view, ttl, startedAt)` keeps nothing when the ref was forgotten at or after `startedAt`.
   - **Comment:** the comment in `routes/parties.ts` then says what is true.
   - **Test:** in `test/unit/guards.test.ts`, a lookup started before a write, finishing after it, keeps nothing.
5. **Reads don't write.** Only routes that change something claim a proof's `jti`:
   - `authenticate` attaches `proof` to the session only for `requireSession` routes whose method isn't `GET`. `optionalSession` routes (`GET /parties`, `POST /parties/lookup`) and `GET` routes check the proof but don't record it.
   - **Trade-off:** a proof copied with its token can re-send that one read, to that exact URL, within its 60 seconds. A write can never be re-sent.
   - **Tests:** the replay tests (`test/unit/dpop.test.ts`, `test/integration/sessions.test.ts`) expect a repeat to be refused on writes and to work on `GET` routes and the lookup. A `GET /v1/me` leaves `used_proofs` empty.
6. **A repeat join that finds the member gone answers with the party.** In `PartyDO.joinNow`, when the session check passes but the membership is gone (they left meanwhile), it answers `{ ok: true, view }` for that person, not joined, instead of `not_found`. `not_found` stays for a party that is gone. Test: in `test/unit/api.test.ts`, the membership is deleted during the check.
7. **Invites held back by the cap are told apart from failures.**
   - **A new error:** `src/do/outbox.ts` gains `class RetryLater extends Error`, and `PartyDO.deliver` throws it when the all-emails cap refuses an invite.
   - **On `RetryLater`, the outbox:**
     - retries with the same backoff;
     - logs once, with `console.info` and the message kind, not as a delivery failure;
     - and when it finally gives up after `MAX_ATTEMPTS`, logs `Dropping an invite the all-emails limit held back` with `console.warn`, so the drop is visible.
   - **Test:** in `test/unit/guards.test.ts`, a held invite logs no failure, and the drop is logged.
8. **The cache test says what it checks.** The `test/integration/spikes.test.ts` case becomes "expire after the time set in PUBLIC_CACHE_MS". The 3-second default stays checked in `test/unit/guards.test.ts` (`viewTtl`).

**Order:** 2, 8, 6 and 4 first (tests and small fixes), then 5 and 7, then 3 with the deploy notes. 1 lands with section 6.

---

## Order of work

0. Review fixes, round 2 (except item 1, which comes with section 6).
1. Traffic spike guards (section 2).
2. Party'o'meter (section 3), then the odometer in santa-barbara.
3. Keep less (section 1), then the one-off cleanup script.
4. Party code lookup (4.1), encrypted tokens (4.2) and token binding (4.3), all in one release with the web app. Binding is enforced from launch once the end-to-end proof tests pass.
5. Auto-prune (section 5), then `scripts/data.ts wake` once after the deploy, so the 7 old open parties are erased by their alarms.
6. Nothing stored before a sign-in link is used (section 6), together with 4.2.
