import { describe, it } from 'vitest';

// Cases from docs/plans/2026-10-at-rest-hotspots-partyometer.md whose code isn't built yet. Each becomes a test in the
// file for its section when its part is built; until then they show as to-dos in every run.

describe('4.1: the party code out of every URL (not built)', () => {
  it.todo('GET /v1/parties?code= is gone');
  it.todo('a live ticket issued with { code } opens only that party\'s socket, and only for a member');
  it.todo('a party ticket is refused on /v1/me/live, and a ticket without a party on /v1/parties/live');
  it.todo('POST /v1/live/ticket with a code is limited like other lookups');
  it.todo('a live ticket opens a socket for 5 minutes');
});

describe('4.2: every token encrypted (not built)', () => {
  it.todo('each token kind is a JWE (alg dir, enc A256GCM), and nothing in it can be read without the key');
  it.todo('a token is refused with another type, a changed byte, another key, or past its expiry');
  it.todo('an expired sign-in link answers link_expired');
  it.todo('the sign-in answer gives expiresAt, and the link\'s party');
  it.todo('magic-link/again sends a new link for a link up to 7 days past expiry, and refuses older ones and other kinds');
});

describe('5: auto-prune (not built)', () => {
  it.todo('an open party with no activity for 45 days is deleted, its host gets one email, and members\' lists drop it');
  it.todo('a join, leave, invite or restore moves the date; a lookup does not');
  it.todo('an auto-deleted party can be restored for 7 days, then is erased; a restore gives it 45 more days');
  it.todo('a host\'s own delete still has 24 hours');
  it.todo('a drawn party is never pruned');
  it.todo('a party already past its date before AUTO_PRUNE_SINCE is erased by its first alarm, with no email, and leaves the host\'s list');
  it.todo('a party used shortly before AUTO_PRUNE_SINCE is pruned with the email at its own date');
});

describe('6: nothing stored before a sign-in link is used (not built)', () => {
  it.todo('a magic-link request, an invite and a new-address check leave no stored object');
  it.todo('the per-address limit counts by address hash, for sign-in links, invites and the email-change link');
  it.todo('the email-change notice to the current address goes out even over that address\'s limit');
  it.todo('a repeated sign-in request sends one email; a repeated account email request is answered from mail_requests');
  it.todo('the account appears only when the link is used');
});
