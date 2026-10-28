# Security and privacy

How Santa Monica protects sessions, tokens, and the data it stores. For the short version, see the [README](../README.md#security-and-privacy).

---

## Sessions

Session tokens last 30 days and carry the account's **token version**.

Every signed-in route checks the version. It does this in the Durable Object call the route already makes, or with one read of the user (`session.verify()`).

These actions bump the version and end every session at once:

- Signing out everywhere
- Changing the email
- Deleting the account
- "This wasn't me" (cancelling an email change)

> [!NOTE]
> `test/integration/revocation.test.ts` calls every route with a revoked token. It fails if a new route is missing from it.

---

## Bound sessions (DPoP)

Sessions can be bound to a key the browser keeps, following [RFC 9449](https://datatracker.ietf.org/doc/html/rfc9449).

### How it works

1. At sign-in, the app sends a public key: a P-256 JWK with only `kty`, `crv`, `x`, and `y`. The private key is not exportable.
2. The session token carries the key's thumbprint (`cnf.jkt`).
3. Every request with that token needs a `DPoP` proof signed by the key. The proof covers the method, URL, and token, and must be made within a minute (`src/utils/dpop.ts`).

### Replay protection

| Route type | Proof is checked | Proof is recorded |
|---|---|---|
| Writes | Yes | Yes. `UserDO.holds` stores its `jti` during the session check, with no extra call. Each proof works once. |
| Reads (GET routes and lookups) | Yes | No, so reads write nothing. |

A token copied from a HAR file, a log, or a header is useless on its own. With its proof, it can at most repeat that one read, to that URL, within that minute.

### Errors

| Problem | Response |
|---|---|
| Missing or wrong proof | `401` |
| Proof only off on its clock | `400`, with the Worker's time in `DPoP-Time`. The app corrects its clock and retries instead of signing out. |

Only bound tokens are accepted (`REQUIRE_BOUND_SESSIONS` is on). Turning it off is the kill switch: see [Deployment](deployment.md#bound-sessions-require_bound_sessions).

---

## Encrypted tokens

Every token (sessions, live tickets, emailed links) is a JWE with `dir` + `A256GCM` (`src/utils/jwt.ts`). The 256-bit key is derived from `JWT_PRIVATE_KEY` with HKDF.

- GCM's tag proves the Worker made the token.
- Nobody holding it can read what's inside, such as an email or party code.
- The token type travels in the authenticated header.

Because the app can't read tokens, the API returns what it needs directly:

| The app needs | It gets it from |
|---|---|
| When the session expires | `expiresAt` at sign-in |
| The link's party | `party` at sign-in |
| Whether a link expired | The `link_expired` error |
| A fresh link | `POST /v1/auth/magic-link/again` (up to 7 days past expiry) |

---

## Emailed links

| Link | Lifetime |
|---|---|
| Sign-in | 5 minutes. An expired one can request a fresh one for 7 days. |
| Email change, deletion, cancel | 1 hour |

Each link works once. The request that used a link can repeat with the same `Idempotency-Key` and get the same result.

Account links carry the token version they were issued for. Any version bump voids every pending link, because someone with a stolen session may have requested several.

---

## Email addresses

Accounts are keyed by the normalized address (`canonicalEmail` in `src/utils/email.ts`):

- Lowercased.
- For Gmail: `+tag` removed, and `googlemail.com` read as `gmail.com`. Gmail delivers all of these to one mailbox.
- Dots are kept, so the address reads the way its owner typed it.

Accounts saved under an older spelling (as typed, or a Gmail address without dots) move to the normalized one on the owner's next sign-in.

**No account enumeration.** Asking to move an account to an address that already has one returns the same response as any other request. That address gets a notice instead of a link.

---

## Input and output

- Input and output are [valibot](https://valibot.dev) schemas (`src/api/schemas.ts`).
- Bodies are strict objects of bounded, trimmed text fields (`src/api/limits.ts`). The web app's forms should use the same limits.
- Unknown fields and values over a limit are refused by name.
- Responses are built from stored records by output schemas, so nothing else leaves the Worker.
- Party codes never appear in a URL. Lookups and writes take the code in the body; a party's live socket gets it from its ticket. This keeps codes out of browser history, proxy logs, and request logs.

---

## Rate limits

A party code is the key to a party without a secret phrase, so codes are hard to guess and slow to try.

| What | Limit | Where |
|---|---|---|
| Party codes | 8 letters (about 2·10^11). Older parties keep 5-letter codes. | `src/api/schemas.ts` |
| Party codes tried per IP | 60/min; 10/min for 5-letter codes. Every route that takes a code counts, since each reveals whether the party exists. Sign-in links to 5-letter codes count too. | `PARTY_LOOKUP_RATE_LIMIT_IP`, `LEGACY_CODE_LOOKUP_RATE_LIMIT_IP` |
| Joins per user | 10/min | `JOIN_RATE_LIMIT_USER` |
| Wrong secret phrases | 5 per person and 20 per party in 15 minutes. The right phrase always gets in. | `src/do/PartyDO.ts` |
| Emails | 10/min per IP; 3/min per address (invites included), counted by a hash of the address. The email-change notice to the current address is never held back. | `ENTER_RATE_LIMIT_IP`, `MAIL_RATE_LIMIT_ADDRESS` |
| Emails, all addresses | About 60/min. A backstop for the sending quota, taken right before sending. Over it, a requested email is a `429` and an invite waits for the outbox's next try. | `MAIL_RATE_LIMIT_ALL` |
| Party'o'meter sockets | 30/min per IP | `STATS_WATCH_RATE_LIMIT_IP` |
| Invites | 10 addresses per request, 3 requests/min per host, 50 per party, one per address per party per day | `INVITE_RATE_LIMIT_USER`, `MAX_PARTY_INVITES` |
| Open parties per host | 3 | `src/api/routes/parties.ts` |
| People per party | 100, host included | `MAX_PARTY_MEMBERS` |
| New parties per person | 10/day, deleted ones included (restoring doesn't count) | `MAX_NEW_PARTIES_PER_DAY` |
| Names | 32 characters (person), 48 (party), and no web addresses (`evil.co`, `www.`, `https://`, emails), since names go into invite emails. Older names keep theirs. | `src/api/limits.ts`, `LINK_RE` in `src/api/schemas.ts` |
| Request body | 16 KB | `src/api/limits.ts` |

### How limits are checked

All Cloudflare rate limits go through `take` and `admit` in `src/api/rateLimit.ts`. Their messages live in one table, `REFUSALS`.

1. Limits are checked broadest first: per client, then per user or address, then all emails together.
2. A later limit is counted only if the earlier ones passed.
3. A refusal is a `429` with `Retry-After: 60`. The trace records which limit hit as `rate_limit.hit`.

"Per IP" means per IPv4 address, or per IPv6 /64 (`rateLimitKey` in `src/utils/ip.ts`): one IPv6 connection usually owns a whole /64, so counting each address would let it try without limit. An IPv4-mapped IPv6 address counts as its IPv4 address.

Cloudflare counts per location and approximately. The phrase and new-party limits are counted exactly by the Durable Objects.

> [!NOTE]
> The per-address email limit is a Rate Limiting binding on purpose, so an address that never signs in leaves nothing stored. The trade-off: it counts per minute, so someone who knows an address can send it about 3 sign-in links a minute.

---

## The draw

The draw is uniformly random over every way to give each person one target other than themselves (`src/utils/santaShuffle.ts`). It uses a cryptographic random source, so nobody can guess who drew whom better than chance.

---

## Data we keep

| Data | How long |
|---|---|
| Profile (email, name) | Until the account is deleted. A deleted account keeps neither. |
| Party members' emails | Until the party is drawn and the draw emails are sent. After that, members are known by id. |
| Invited addresses | One day, to skip repeat invites. |
| Expired link and request records | Deleted when the object starts. |
| Sign-in requests, invites, email changes to a new address | Nothing is stored for that address until a link is used. A wrong secret phrase on an invite is counted in the party, under a hash of the address. |
| Open parties with no activity | Deleted after 45 days. The host gets an email and can restore it for 7 days, then it's erased with members' emails. |
| Deleted parties (by the host) | Restorable for 24 hours, then erased. |

Each object cleans up after itself. `scripts/data.ts tidy` does it for objects nobody opens anymore.

`UserDO` creates its tables on its first write, so an address that never signs in has nothing stored. A sign-in request keeps everything in its link.

**Backups.** Cloudflare keeps 30 days of point-in-time history, so deleted data stays there that long.

**Encryption at rest.** The app doesn't encrypt stored data; Cloudflare encrypts it on disk. Anyone who could read it otherwise (Data Studio needs Editor access to the Worker) could also deploy code that reads any key. Keeping less is what protects it.

---

## Due times

A party can have a due time: roughly when the host plans to roll the dice. The app counts down to it. Nothing happens when it passes.

- The host gets one reminder email the day before, at the time of day the party was created (`reminderAt` in `src/do/PartyDO.ts`: 12 to 36 hours ahead, whatever their time zone).
- The reminder is sent through the party's alarm and outbox.
- Only open parties get one. A drawn party gets none. A deleted party keeps it for when it's restored, unless the due time has passed.

---

## Signed-out party views

Signed-out party views are kept in the Worker's memory for 3 seconds (never in a cache). A party link that goes viral doesn't send every visitor to the same Durable Object.

- A write through the Worker (join, leave, draw, invite, delete, restore, or an account deletion that erases the party) clears the view in that isolate right away.
- Other isolates see the change within 3 seconds.
- A lookup that started before such a write keeps nothing, so it can't restore the old view.

---

## Logs

Logs and traces never contain emails, names, or party codes.

Every request is logged; 1 in 10 is traced (`head_sampling_rate` in `wrangler.jsonc`). Logs aren't sampled, so the `errorId` a 500 hands back can always be found.

Parties appear as `party.ref`: a 12-hex-digit HMAC of the code, keyed from `JWT_PRIVATE_KEY` (`src/utils/logRef.ts`). You can follow a party's requests, but you can't recover its code.

---

## HTTP

- Only origins in `ALLOWED_ORIGINS` (`wrangler.jsonc`) get CORS headers.
- Responses carry HSTS, `X-Frame-Options`, `nosniff`, and a no-referrer policy.
- Responses carry `Cache-Control: no-store`, so no browser or proxy keeps a profile, a party view or a session token. Only the stats are public (`max-age=10`).
