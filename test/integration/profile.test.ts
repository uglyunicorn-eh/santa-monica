import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { UserToken } from 'src/api/types';

import {
  Person, apiError, call, createParty, drawParty, joinParty, jwt, magicLinkToken, mailbox, me, mintUserToken,
  myParties, redeem, requestMagicLink, signIn, uniqueEmail, viewParty,
} from './support';

const person = (label: string) => signIn(uniqueEmail(label));

const rename = (who: { token?: string }, name: unknown) => call('PATCH', '/v1/me', { token: who.token, body: { name } });

/** Pages through the history the way the front end does, returning every page. */
async function allPages(who: Person, first: number) {
  const pages = [];
  let after: string | null = null;
  for (let i = 0; i < 10; i++) {
    const query: string = `?first=${first}${after ? `&after=${encodeURIComponent(after)}` : ''}`;
    const page = (await myParties(who, query)).body;
    pages.push(page);
    if (!page.hasMore) break;
    after = page.endCursor;
  }
  return pages;
}

describe('the signed-in user', () => {
  it('includes their email, also right after signing in', async () => {
    const email = uniqueEmail('me');
    const who = await signIn(email);
    expect(await me(who)).toEqual({ status: 200, body: { id: who.id, name: '', email } });
  });

  it('shows nothing but a name for other people, such as a party target', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');
    await drawParty(host, party);
    expect((await viewParty(party.code, host)).body.target).toEqual({ name: 'Guest' });
  });
});

describe('updating the profile name', () => {
  it('needs a session', async () => {
    expect((await rename({}, 'Nope')).status).toBe(401);
  });

  it('sets the name, cleaned up, and returns the user; repeating it changes nothing', async () => {
    const who = await person('me');
    const res = await rename(who, '  Santa   Claus ');
    expect(res).toEqual({ status: 200, body: { id: who.id, name: 'Santa Claus', email: who.email } });
    expect(await rename(who, '  Santa   Claus ')).toEqual(res);
    expect((await me(who)).body.name).toBe('Santa Claus');
  });

  it('validates the name', async () => {
    const who = await person('me');
    for (const name of ['', '   ', 'x'.repeat(101), 7, null]) {
      expect(await rename(who, name)).toMatchObject({ status: 400, body: apiError('invalid', undefined, 'name') });
    }
  });

  it('is only the default for new parties: open and drawn parties keep the name I joined with', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const open = await createParty(host, 'Open');
    const drawn = await createParty(host, 'Drawn');
    await joinParty(guest, open, 'Joined as');
    await joinParty(guest, drawn, 'Joined as');
    await drawParty(host, drawn);

    await rename(guest, 'Renamed');
    expect((await viewParty(open.code, host)).body.participants).toEqual(['', 'Joined as']);
    expect((await viewParty(drawn.code, host)).body).toMatchObject({ participants: ['', 'Joined as'], target: { name: 'Joined as' } });

    // A later join doesn't overwrite the edited profile name.
    const later = await createParty(host, 'Later');
    await joinParty(guest, later, 'Typed in the form');
    expect((await me(guest)).body.name).toBe('Renamed');
  });
});

describe('party history', () => {
  it('pages through every party exactly once, newest first', async () => {
    // Hosting is limited to 3 open parties, so most of the history is parties joined.
    const who = await person('me');
    const friends = await Promise.all([1, 2, 3, 4].map(i => person(`friend${i}`)));
    const created: string[] = [];
    for (let i = 0; i < 12; i++) {
      if (i % 6 === 5) {
        created.push((await createParty(who, `Party ${i}`)).code);
      } else {
        const party = await createParty(friends[i % 4], `Party ${i}`);
        await joinParty(who, party, 'Me');
        created.push(party.code);
      }
    }
    const pages = await allPages(who, 10);
    expect(pages.map(p => [p.items.length, p.hasMore])).toEqual([[10, true], [2, false]]);
    expect(pages.flatMap(p => p.items.map(item => item.code))).toEqual(created.reverse());
    expect(pages[0].items[0]).toMatchObject({ name: 'Party 11', isHost: true, isJoined: true });
    expect(pages[0].items[1]).toMatchObject({ name: 'Party 10', isHost: false, isJoined: true });
  });

  it('defaults to ten per page', async () => {
    const who = await person('me');
    await createParty(who, 'Only');
    expect((await myParties(who)).body).toMatchObject({ items: [{ name: 'Only' }], hasMore: false });
  });

  it('includes parties I joined, and is empty for a new user', async () => {
    const who = await person('me');
    expect((await myParties(who)).body).toEqual({ items: [], hasMore: false, endCursor: null });
    const friend = await person('friend');
    const theirs = await createParty(friend, 'Theirs');
    await joinParty(who, theirs, 'Me');
    expect((await myParties(who)).body.items).toMatchObject([{ code: theirs.code, name: 'Theirs', isHost: false, isJoined: true }]);
  });

  it('needs a session, and rejects a malformed cursor', async () => {
    expect((await myParties({})).status).toBe(401);
    const who = await person('me');
    expect(await myParties(who, '?after=garbage')).toEqual({ status: 400, body: apiError('invalid', 'Invalid cursor.', 'after') });
  });
});

describe('session tokens', () => {
  it('carries the token version in new session tokens', async () => {
    const email = uniqueEmail('me');
    await requestMagicLink(email);
    const entered = await redeem(magicLinkToken((await mailbox(email)).at(-1)!));
    expect(await jwt().jwtVerify<UserToken>(entered.body.userToken, 'UserToken')).toMatchObject({ email, ver: 0 });
  });

  it('keeps accepting tokens issued before versions existed', async () => {
    const who = await person('me');
    const legacy = { token: await mintUserToken({ sub: who.id, email: who.email }) };
    expect(await me(legacy)).toMatchObject({ status: 200, body: { id: who.id } });
    expect((await rename(legacy, 'Legacy')).status).toBe(200);
    const host = await person('host');
    const party = await createParty(host);
    expect((await joinParty(legacy, party, 'Legacy')).status).toBe(200);
    expect((await createParty({ ...who, token: legacy.token }, 'Mine')).name).toBe('Mine');
  });

  it('starts a new account when a deleted email signs in again; the old tokens stay revoked', async () => {
    const email = uniqueEmail('again');
    const before = await signIn(email);
    await env.USER.getByName(email).tombstone();
    const after = await signIn(email);

    expect(after.id).not.toBe(before.id);
    expect(await jwt().jwtVerify<UserToken>(after.token, 'UserToken')).toMatchObject({ ver: 1 });
    expect(await me(after)).toEqual({ status: 200, body: { id: after.id, name: '', email } });
    expect((await me(before)).status).toBe(401);
  });
});
