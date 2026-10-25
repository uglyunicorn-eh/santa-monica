import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { UserToken } from 'src/apollo/types';

import {
  ENTER, JOIN_PARTY, PARTY, Person, createParty, gql, joinParty, jwt, mailbox, magicLinkToken, mintUserToken,
  signInWithMagicLink, uniqueEmail,
} from './support';

const person = (label: string) => signInWithMagicLink(uniqueEmail(label));

const USER = `{ user { id name email } }`;

const UPDATE_NAME = `
  mutation ($name: String!) {
    profile { updateName(input: { name: $name }) { status userErrors { fieldName messages } user { id name email } } }
  }`;

const HISTORY = `
  query ($first: Int, $after: String) {
    partyHistory(first: $first, after: $after) { items { code name isHost isJoined } hasMore endCursor }
  }`;

/** Pages through partyHistory the way the front end does, returning every page. */
async function allPages(me: Person, first: number) {
  const pages = [];
  let after: string | null = null;
  for (let i = 0; i < 10; i++) {
    const page: any = (await gql(HISTORY, { first, after }, { token: me.token })).data.partyHistory;
    pages.push(page);
    if (!page.hasMore) break;
    after = page.endCursor;
  }
  return pages;
}

describe('the signed-in user', () => {
  it('includes their email, also right after signing in', async () => {
    const email = uniqueEmail('me');
    const me = await signInWithMagicLink(email);
    expect((await gql(USER, {}, { token: me.token })).data.user).toEqual({ id: me.id, name: '', email });
  });

  it('shows no email for other people, such as a party target', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const party = await createParty(host);
    await joinParty(guest, party, 'Guest');
    await gql(`mutation ($party: ID!) { parties { closeParty(input: { party: $party }) { status } } }`, { party: party.id }, { token: host.token });
    const view = await gql(`query ($code: String!) { party(code: $code) { target { id name email } } }`, { code: party.code }, { token: host.token });
    expect(view.data.party.target).toEqual({ id: guest.id, name: 'Guest', email: null });
  });
});

describe('updating the profile name', () => {
  it('needs a session', async () => {
    expect((await gql(UPDATE_NAME, { name: 'Nope' })).errors?.[0]?.message).toBe('UNAUTHENTICATED');
  });

  it('sets the name, cleaned up, and returns the user', async () => {
    const me = await person('me');
    const res = (await gql(UPDATE_NAME, { name: '  Ded   Moroz ' }, { token: me.token })).data.profile.updateName;
    expect(res).toEqual({ status: 'ok', userErrors: null, user: { id: me.id, name: 'Ded Moroz', email: me.email } });
    expect((await gql(USER, {}, { token: me.token })).data.user.name).toBe('Ded Moroz');
  });

  it('validates the name', async () => {
    const me = await person('me');
    for (const name of ['', '   ', 'x'.repeat(101)]) {
      expect((await gql(UPDATE_NAME, { name }, { token: me.token })).data.profile.updateName).toMatchObject({
        status: 'error', userErrors: [{ fieldName: 'name' }], user: null,
      });
    }
  });

  it('is only the default for new parties: open and drawn parties keep the name I joined with', async () => {
    const host = await person('host');
    const guest = await person('guest');
    const open = await createParty(host, 'Open');
    const drawn = await createParty(host, 'Drawn');
    await joinParty(guest, open, 'Joined as');
    await joinParty(guest, drawn, 'Joined as');
    await gql(`mutation ($party: ID!) { parties { closeParty(input: { party: $party }) { status } } }`, { party: drawn.id }, { token: host.token });

    await gql(UPDATE_NAME, { name: 'Renamed' }, { token: guest.token });
    expect((await gql(PARTY, { code: open.code }, { token: host.token })).data.party.participants).toEqual(['', 'Joined as']);
    const drawnView = (await gql(PARTY, { code: drawn.code }, { token: host.token })).data.party;
    expect(drawnView).toMatchObject({ participants: ['', 'Joined as'], target: { name: 'Joined as' } });

    // A later join doesn't overwrite the edited profile name.
    const later = await createParty(host, 'Later');
    await joinParty(guest, later, 'Typed in the form');
    expect((await gql(USER, {}, { token: guest.token })).data.user.name).toBe('Renamed');
  });
});

describe('party history', () => {
  it('pages ten at a time, newest first, with every party exactly once', async () => {
    const me = await person('me');
    const created = [];
    for (let i = 0; i < 12; i++) {
      created.push((await createParty(me, `Party ${i}`)).code);
    }
    const pages = await allPages(me, 10);
    expect(pages.map(p => [p.items.length, p.hasMore])).toEqual([[10, true], [2, false]]);
    expect(pages.flatMap(p => p.items.map((item: any) => item.code))).toEqual(created.reverse());
    expect(pages[0].items[0]).toMatchObject({ name: 'Party 11', isHost: true, isJoined: true });
  });

  it('defaults to ten per page', async () => {
    const me = await person('me');
    await createParty(me, 'Only');
    expect((await gql(`{ partyHistory { items { name } hasMore } }`, {}, { token: me.token })).data.partyHistory).toEqual({
      items: [{ name: 'Only' }], hasMore: false,
    });
  });

  it('includes parties I joined, and is empty for a new user', async () => {
    const me = await person('me');
    expect((await gql(HISTORY, {}, { token: me.token })).data.partyHistory).toEqual({ items: [], hasMore: false, endCursor: null });
    const friend = await person('friend');
    const theirs = await createParty(friend, 'Theirs');
    await joinParty(me, theirs, 'Me');
    expect((await gql(HISTORY, {}, { token: me.token })).data.partyHistory.items).toEqual([
      { code: theirs.code, name: 'Theirs', isHost: false, isJoined: true },
    ]);
  });

  it('is null without a session, and rejects a malformed cursor', async () => {
    expect((await gql(HISTORY)).data.partyHistory).toBeNull();
    const me = await person('me');
    const res = await gql(HISTORY, { after: 'garbage' }, { token: me.token });
    expect(res.errors?.[0]?.message).toBe('Invalid cursor.');
  });
});

describe('session tokens and revocation', () => {
  it('carries the token version in new session tokens', async () => {
    const email = uniqueEmail('me');
    await gql(`mutation ($email: String!) { auth { enterRequest(input: { email: $email }) { status } } }`, { email });
    const entered = (await gql(ENTER, { token: magicLinkToken((await mailbox(email)).at(-1)!) })).data.auth.enter;
    expect(await jwt().jwtVerify<UserToken>(entered.userToken, 'UserToken')).toMatchObject({ email, ver: 0 });
  });

  it('keeps accepting tokens issued before versions existed', async () => {
    const me = await person('me');
    const legacy = await mintUserToken({ sub: me.id, email: me.email });
    expect((await gql(USER, {}, { token: legacy })).data.user).toMatchObject({ id: me.id });
    expect((await gql(UPDATE_NAME, { name: 'Legacy' }, { token: legacy })).data.profile.updateName.status).toBe('ok');
    const host = await person('host');
    const party = await createParty(host);
    expect((await gql(JOIN_PARTY, { party: party.id, name: 'Legacy' }, { token: legacy })).data.parties.joinParty.status).toBe('ok');
    expect((await createParty({ ...me, token: legacy }, 'Mine')).name).toBe('Mine');
  });

  it('stops a deleted account\'s tokens: no user, no profile changes, no new or joined parties', async () => {
    const host = await person('host');
    const party = await createParty(host);
    const me = await person('me');
    const legacy = await mintUserToken({ sub: me.id, email: me.email });
    await env.USER.getByName(me.email).tombstone();

    for (const token of [me.token, legacy]) {
      expect((await gql(USER, {}, { token })).data.user).toBeNull();
      expect((await gql(UPDATE_NAME, { name: 'Back' }, { token })).data.profile.updateName).toMatchObject({ status: 'error', userErrors: [{ fieldName: null }] });
      const created = await gql(`mutation { parties { createParty(input: { name: "Nope" }) { status } } }`, {}, { token });
      expect(created.data.parties.createParty.status).toBe('error');
      const joined = (await gql(JOIN_PARTY, { party: party.id, name: 'Ghost' }, { token })).data.parties.joinParty;
      expect(joined).toMatchObject({ status: 'error', userErrors: [{ fieldName: null }], node: null });
    }
    expect((await gql(PARTY, { code: party.code }, { token: host.token })).data.party.participantCount).toBe(1);
  });

  it('starts a new account when a deleted email signs in again; the old tokens stay revoked', async () => {
    const email = uniqueEmail('again');
    const before = await signInWithMagicLink(email);
    await env.USER.getByName(email).tombstone();
    const after = await signInWithMagicLink(email);

    expect(after.id).not.toBe(before.id);
    expect(await jwt().jwtVerify<UserToken>(after.token, 'UserToken')).toMatchObject({ ver: 1 });
    expect((await gql(USER, {}, { token: after.token })).data.user).toEqual({ id: after.id, name: '', email });
    expect((await gql(USER, {}, { token: before.token })).data.user).toBeNull();
  });
});
