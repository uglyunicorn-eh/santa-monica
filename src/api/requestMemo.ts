// Repeats of an email request to an address that has no account yet (a sign-in link, the email-change link to a new
// address), answered without sending again. Kept in the isolate's memory, never in storage: nothing is stored for a
// sign-in request until its link is used. A repeat that reaches another isolate sends one more email, which the
// per-address limit still bounds; the app's busy button stops double clicks anyway.

/** How long a request is remembered, like the stored claims of account emails (`MAIL_REQUEST_TTL_MS`). */
export const REQUEST_MEMO_MS = 10 * 60 * 1000;

/** Requests remembered at once. Over it, the oldest is dropped. */
export const MAX_REMEMBERED_REQUESTS = 500;

const requests = new Map<string, { detail: string; until: number }>();

/** Whether this request (same key and detail) was made in the last REQUEST_MEMO_MS. `key` is already hashed. */
export function seenRequest(key: string, detail: string, now = Date.now()): boolean {
  const entry = requests.get(key);
  if (entry && entry.until <= now) {
    requests.delete(key);
    return false;
  }
  return entry?.detail === detail;
}

/**
 * Claims a request before its email goes out, so a repeat made meanwhile (a double click, a retry racing the first)
 * sends nothing. `forgetRequest` lets it go again if the email couldn't be sent.
 */
export function rememberRequest(key: string, detail: string, now = Date.now()) {
  requests.delete(key);
  if (requests.size >= MAX_REMEMBERED_REQUESTS) {
    requests.delete(requests.keys().next().value!);
  }
  requests.set(key, { detail, until: now + REQUEST_MEMO_MS });
}

/** Lets go of a claimed request whose email didn't go out, so a retry of it sends one. */
export function forgetRequest(key: string, detail: string) {
  if (requests.get(key)?.detail === detail) {
    requests.delete(key);
  }
}

/** Forgets every request. Used by tests. */
export const forgetRequests = () => requests.clear();
