# API reference

The Santa Monica API is organized around REST-like routes. It accepts JSON request bodies, returns JSON responses, and uses standard HTTP status codes and [authentication](#authentication).

**Base URL:** `https://api.gnomik.me/v1`

Party codes always go in the request body, never in the URL. This keeps them out of browser history and request logs.

## Authentication

Authenticate a request by sending a session token in the `Authorization` header:

```
Authorization: Bearer <userToken>
```

To get a session token, send a magic link and redeem it:

1. Call [`POST /auth/magic-link`](#send-a-magic-link) with the person's email address. They receive an email with a link.
2. Call [`POST /auth/session`](#create-a-session) with the token from that link. The response contains a [session](#the-session-object).

Sessions last 30 days. Treat every token as an opaque string: tokens are encrypted, and only the API can read them.

### Bind a session to the browser

Production accepts only bound sessions. To bind a session, pass `key` when you create it: the public half of a P-256 key pair that the browser keeps. Then sign every request made with that session with a `DPoP` proof from the matching private key, following [RFC 9449](https://datatracker.ietf.org/doc/html/rfc9449).

A leaked token is useless without the key. See [Bound sessions](security.md#bound-sessions-dpop) for how proofs are checked.

## Errors

The API uses conventional HTTP status codes. A `2xx` code means the request succeeded, a `4xx` code means the request failed because of the information it carried, and a `5xx` code means the API had a problem.

Every error has the same shape:

```json
{ "error": { "code": "not_found", "message": "Party does not exist.", "field": "party" } }
```

| Attribute | Description |
|---|---|
| `code` | A short string that identifies the error. Branch on this, not on `message`. |
| `message` | A human-readable message you can show to the person. |
| `field` | The request field the error relates to, if any. |

| Status | Codes | Meaning |
|---|---|---|
| `400` | `invalid`, `invalid_link`, `link_expired` | The request or the emailed link isn't valid. |
| `401` | `unauthenticated` | The session is missing, invalid, or revoked. Sign the person out. |
| `403` | `forbidden`, `not_member` | The person isn't allowed to do this. |
| `404` | `not_found` | The party doesn't exist, or the person can't see it. |
| `409` | `conflict`, `link_used`, `account_busy` | The request conflicts with the current state. |
| `429` | `rate_limited` | Too many requests. Retry after the number of seconds in `Retry-After`. |
| `500` | `internal` | Something went wrong on the API's side. The response includes an `errorId` you can find in the logs. |
| `503` | `unavailable`, `not_finished` | A dependency couldn't be reached. Retry the request. |

> [!NOTE]
> Emailed-link problems never return `401`. A `401` always means the session itself is no longer valid.

## Idempotent requests

Every write is safe to retry. Joining, leaving, drawing, deleting, restoring, and renaming return the current state when the change is already done.

Routes that send email or create something also accept an `Idempotency-Key` header: 16 to 100 characters, using letters, digits, `-`, and `_`. If you retry a request with the same key within 10 minutes, you get the same response, and the work isn't done twice. Sign-in routes use the key to let a retried request sign in again with a link it already used.

## Rate limits

The API limits how often you can call some routes. A refused request returns `429` with `Retry-After: 60`. See [Rate limits](security.md#rate-limits) for every limit.

---

## Sessions

A session signs a person in. You create one from an emailed link.

### The session object

| Attribute | Type | Description |
|---|---|---|
| `userToken` | string | The session token. Send it in the `Authorization` header. |
| `user` | [user](#the-user-object) | The signed-in person. |
| `expiresAt` | string | When the session stops working, as an ISO 8601 timestamp. |
| `party` | string or null | The party code the link was for, so you can take the person there. Null if the link wasn't for a party. |

### Send a magic link

`POST /auth/magic-link`

Emails a sign-in link that works for 5 minutes. The API stores nothing until the link is used.

| Parameter | Type | Description |
|---|---|---|
| `email` | string, **required** | The person's email address. Up to 128 characters. |
| `party` | string | A party code. The link takes the person to that party after signing in. |

**Returns** `202` with `{ "ok": true }`. With an `Idempotency-Key`, a repeat sends nothing and doesn't count toward the rate limit.

**Errors:** `not_found` if the party doesn't exist; `rate_limited`.

### Resend an expired link

`POST /auth/magic-link/again`

Emails a fresh sign-in link for an expired one, to the same address and for the same party. Use it when a link returns `link_expired`: you can't read the address from the link yourself, because links are encrypted.

| Parameter | Type | Description |
|---|---|---|
| `token` | string, **required** | The expired sign-in link, invite, or party sign-in link, up to 7 days past its expiry. |

**Returns** `202` with `{ "ok": true }`.

**Errors:** `invalid_link`; for a party sign-in link, `not_member` if the account is no longer at that address, and `account_busy` while the account is being changed; `rate_limited`.

### Create a session

`POST /auth/session`

Signs a person in with the token from a magic link, creating their account on the first sign-in. Each link works once.

| Parameter | Type | Description |
|---|---|---|
| `token` | string, **required** | The token after `#` in the link. |
| `key` | object | A public P-256 JWK (`kty`, `crv`, `x`, `y`) to [bind the session](#bind-a-session-to-the-browser) to. |

**Returns** a [session](#the-session-object). Retrying with the same `Idempotency-Key` signs in again.

**Errors:** `link_expired`, `invalid_link`, `link_used`.

### Accept an invite

`POST /auth/invite`

Signs the invited address in and joins the party in one step. The account is created if the address doesn't have one.

| Parameter | Type | Description |
|---|---|---|
| `token` | string, **required** | The token from the invite email. |
| `name` | string, **required** | The name to join the party under. Up to 32 characters. |
| `password` | string | The party's secret phrase, if it has one. Up to 100 characters. |
| `key` | object | A public key to [bind the session](#bind-a-session-to-the-browser) to. |

**Returns** a [session](#the-session-object) with `party` set. If the address is already a member, the API emails a magic link for the party instead and returns `202`, so an old or forwarded invite can't open their account.

**Errors:** `forbidden` for a wrong secret phrase (the invite stays unused, so the person can try again); `rate_limited` after too many wrong phrases; `not_found` or `conflict` if the party is gone, drawn, or full; `link_expired`, `invalid_link`, `link_used`.

### Sign in with a party link

`POST /auth/party-link`

Signs a member in with the link in a party's "dice are rolled" email or the host's reminder the day before. The link signs in only the member it was sent to, and never creates an account.

| Parameter | Type | Description |
|---|---|---|
| `token` | string, **required** | The token after `#` in the link. |
| `key` | object | A public key to [bind the session](#bind-a-session-to-the-browser) to. |

**Returns** a [session](#the-session-object) with `party` set. Retrying with the same `Idempotency-Key` signs in again.

**Errors:**
- `not_member` if the person is no longer in the party, or the address no longer holds their account. The link stays unused, so fall back to email sign-in.
- `account_busy` while an email change or deletion is in progress. The link stays unused.
- `link_expired`, `invalid_link`, `link_used`.

---

## Users

The signed-in person's account.

### The user object

| Attribute | Type | Description |
|---|---|---|
| `id` | string | The user's ID. |
| `name` | string | The profile name, used as the default name for new parties. Can be empty. |
| `email` | string | The account's email address. |
| `joinedAt` | string | When the account was created. |
| `parties` | object | Counts of parties: `joined`, `rolled`, `hosted`. Only returned by `GET /me` and `PATCH /me`. |

### Retrieve the current user

`GET /me`

**Returns** the signed-in [user](#the-user-object), with `parties`.

### Update the current user

`PATCH /me`

Sets the profile name. Parties already joined keep the name the person joined them with.

| Parameter | Type | Description |
|---|---|---|
| `name` | string, **required** | Up to 32 characters. Can't contain a web address. |

**Returns** the updated [user](#the-user-object).

### List the user's parties

`GET /me/parties`

Returns the parties the person hosts or has joined, newest first.

| Query parameter | Type | Description |
|---|---|---|
| `first` | integer | How many parties to return, from 1 to 100. Defaults to 10. |
| `after` | string | The `endCursor` from the previous page. |

**Returns** `{ items, hasMore, endCursor }`. Each item is a [party](#the-party-object) without `dueAt`, `password`, `participantCount`, `participants`, and `target`.

### List unrevealed parties

`GET /me/parties/unrevealed`

Returns rolled parties from the last month where the person hasn't seen their match yet, newest first, up to 10.

**Returns** `{ items }`, where each item is `{ code, name, closedAt }`.

### Mark a party as revealed

`POST /me/parties/revealed`

Records that the person saw their match in a rolled party.

| Parameter | Type | Description |
|---|---|---|
| `code` | string, **required** | The party code. |

**Returns** `{ "ok": true }`.

**Errors:** `not_found` if the person has no rolled party with this code.

### Sign out everywhere

`POST /me/sign-out`

Ends every session on every device.

**Returns** `{ "ok": true }`.

### Change the email address

Changing the email address takes two steps: request a confirmation link, then confirm it from the new address.

#### Request an email change

`POST /me/email-change`

Emails a confirmation link to the new address, and a notice with a "This wasn't me" link to the current one. Both links work for 1 hour.

| Parameter | Type | Description |
|---|---|---|
| `email` | string, **required** | The new address. |

**Returns** `202` with `{ "ok": true }`, whether or not the new address already has an account. That address gets a notice instead of a link.

**Errors:** `invalid` if it's already the account's address; `rate_limited`.

#### Confirm an email change

`POST /me/email-change/confirm`

Moves the account to the new address. Every earlier session stops working.

| Parameter | Type | Description |
|---|---|---|
| `token` | string, **required** | The token from the confirmation link. |
| `key` | object | A public key to [bind the new session](#bind-a-session-to-the-browser) to. |

**Returns** a [session](#the-session-object) on the new address.

**Errors:** `conflict` if another account took the new address in the meantime; `invalid_link`, `link_used`, `account_busy`; `not_finished` (open the link again in a few minutes).

#### Cancel an email change

`POST /me/email-change/cancel`

Stops a pending email change from the "This wasn't me" link, and signs out everywhere. The account keeps its email address.

| Parameter | Type | Description |
|---|---|---|
| `token` | string, **required** | The token from the notice. |

**Returns** `{ "ok": true }`.

### Delete the account

Deleting an account takes two steps: request a deletion link, then confirm it.

#### Request account deletion

`POST /me/deletion`

Emails a deletion link that works for 1 hour.

**Returns** `202` with `{ "ok": true }`.

#### Check a deletion link

`POST /me/deletion/check`

Checks a deletion link without using it, so you can show which account it deletes before the person confirms.

| Parameter | Type | Description |
|---|---|---|
| `token` | string, **required** | The token from the deletion link. |

**Returns** `{ email }`. Returns the same errors as confirming.

#### Confirm account deletion

`POST /me/deletion/confirm`

Deletes the account and ends every session:
- Open parties the person hosts are deleted.
- Open parties they joined are left.
- In drawn parties, their membership stays but is made anonymous, so the draw holds.

| Parameter | Type | Description |
|---|---|---|
| `token` | string, **required** | The token from the deletion link. |

**Returns** `{ "ok": true }`.

**Errors:** `invalid_link`, `link_used`, `account_busy`; `not_finished` (open the link again in a few minutes).

---

## Parties

A party is a Secret Santa group: a host, members, and once the host rolls the dice, a match for each member.

### The party object

| Attribute | Type | Description |
|---|---|---|
| `code` | string | The party code, 8 letters. Older parties have 5. |
| `name` | string | The party's name. |
| `isHost` | boolean | Whether the person is the host. |
| `isJoined` | boolean | Whether the person is a member. |
| `isProtected` | boolean | Whether joining needs a secret phrase. |
| `isClosed` | boolean | Whether the dice are rolled. |
| `createdAt` | string | When the party was created. |
| `rolledAt` | string or null | When the dice were rolled. |
| `deletedAt` | string or null | When the host deleted the party. Only the host sees a deleted party. |
| `restorableUntil` | string or null | Until when the host can restore a deleted party. |
| `dueAt` | string or null | When the host plans to roll the dice. |
| `password` | string or null | The secret phrase. Only the host sees it. |
| `participantCount` | integer or null | How many people are in. Only members see it. |
| `participants` | array or null | Names of people in the party. The host sees everyone; other members see up to three besides themselves. |
| `target` | object or null | The person's match once the dice are rolled: `{ name }`. |

### Retrieve a party

`POST /parties/lookup`

Retrieves a party by its code. The session is optional: signed out, you get the public view.

| Parameter | Type | Description |
|---|---|---|
| `code` | string, **required** | The party code, in any case. |

**Returns** the [party](#the-party-object).

**Errors:** `not_found`; `rate_limited` after too many codes from one IP.

### Create a party

`POST /parties`

Creates a party with the signed-in person as its host.

| Parameter | Type | Description |
|---|---|---|
| `name` | string, **required** | Up to 48 characters. Can't contain a web address. |
| `password` | string | A secret phrase people need to join. Up to 100 characters. |
| `dueAt` | string | When the host plans to roll the dice, as an ISO 8601 date-time with an offset. Between 1 hour and 1 year from now. The host gets a reminder the day before. |

**Returns** `201` with the [party](#the-party-object). With an `Idempotency-Key`, a repeat with the same name returns the same party.

**Errors:** `invalid`; `conflict` if the person already hosts 3 open parties; `rate_limited`.

### Join a party

`POST /parties/join`

| Parameter | Type | Description |
|---|---|---|
| `code` | string, **required** | The party code. |
| `name` | string, **required** | The name to join under. Up to 32 characters. |
| `password` | string | The secret phrase, if the party has one. |

**Returns** the [party](#the-party-object).

**Errors:** `forbidden` for a wrong secret phrase; `conflict` if the party is drawn or full; `not_found`; `rate_limited`.

### Leave a party

`POST /parties/leave`

| Parameter | Type | Description |
|---|---|---|
| `code` | string, **required** | The party code. |

**Returns** the [party](#the-party-object).

**Errors:** `conflict` if the dice are already rolled, or if the person is the host (a host deletes the party instead); `not_found`.

### Roll the dice

`POST /parties/draw`

Draws a match for every member and emails each of them. Only the host can do this, and the party needs at least two people.

| Parameter | Type | Description |
|---|---|---|
| `code` | string, **required** | The party code. |

**Returns** the [party](#the-party-object), with `target` set. A repeat returns the same draw and emails nobody again.

**Errors:** `forbidden` if the person isn't the host; `conflict` if the party has fewer than two people; `not_found`.

### Invite people

`POST /parties/invite`

Emails invites. Only the host can invite, while the party is open. Each invite carries a link that signs the person in and joins them.

| Parameter | Type | Description |
|---|---|---|
| `code` | string, **required** | The party code. |
| `emails` | array of strings, **required** | 1 to 10 email addresses. |

**Returns** `{ invited, alreadyInvited, alreadyJoined, invitesLeft }`. Addresses already in the party, or invited in the last day, aren't emailed again. A party can send 50 invites in all.

**Errors:** `forbidden` if the person isn't the host; `conflict` if the dice are already rolled; `not_found`; `rate_limited`.

### Delete a party

`POST /parties/delete`

Deletes a party. Only the host can delete it, and only before the dice are rolled. The host can restore it for 24 hours.

| Parameter | Type | Description |
|---|---|---|
| `code` | string, **required** | The party code. |

**Returns** the [party](#the-party-object), with `deletedAt` set.

**Errors:** `forbidden` if the person isn't the host; `conflict` if the dice are already rolled; `not_found`.

### Restore a party

`POST /parties/restore`

Restores a deleted party. Only the host can restore it.

| Parameter | Type | Description |
|---|---|---|
| `code` | string, **required** | The party code. |

**Returns** the [party](#the-party-object).

**Errors:** `conflict` if the restore window has passed, or if the host already has 3 open parties; `not_found`.

---

## Live updates

Live updates use WebSockets. Browsers can't send an `Authorization` header on a WebSocket, so you trade the session for a short-lived ticket first.

### Create a ticket

`POST /live/ticket`

| Parameter | Type | Description |
|---|---|---|
| `code` | string | A party code, for that party's updates. Leave it out for the person's own updates. |

**Returns** `{ ticket }`. The ticket works for 5 minutes.

### Watch a party

`GET /parties/live?ticket=<ticket>`

Opens a WebSocket that sends `{"type":"party.changed"}` after every change. Fetch the party again when you get one. Only members, and the host of a deleted party, can watch.

### Watch the account

`GET /me/live?ticket=<ticket>`

Opens a WebSocket that sends:
- `{"type":"party.rolled","code":"…","name":"…"}` when one of the person's parties rolls its dice.
- `{"type":"party.revealed","code":"…"}` when they see their match, in any tab.

### Retrieve the Party'o'meter

`GET /stats`

Returns how many parties have rolled their dice. No session needed.

**Returns** `{ rolled }`.

### Watch the Party'o'meter

`GET /stats/live`

Opens a WebSocket that sends `{"type":"stats","rolled":N}` when the count changes. No ticket needed.
