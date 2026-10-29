import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { nodeIdToStr } from 'src/utils/strings/nodeId';

import {
  createParty, drawParty, joinParty, magicLinkToken, mailbox, me, mintUserToken, myParties, redeem, requestMagicLink,
  settleParty, signIn, uniqueEmail, uniqueIp, viewParty,
} from './support';

/** A fresh Gmail user name, with no dots or dashes. */
const gmailUser = () => uniqueEmail('g').split('@')[0].replaceAll('-', '');
const dotted = (id: string) => `${id.slice(0, 2)}.${id.slice(2)}`;

/** Asks for a magic link with `spelling` and follows the link, read from the normalized address's mailbox. */
async function signInAs(spelling: string, normalized: string) {
  const before = (await mailbox(normalized)).length;
  expect((await requestMagicLink(spelling)).status).toBe(202);
  const mails = await mailbox(normalized);
  expect(mails).toHaveLength(before + 1);
  return await redeem(magicLinkToken(mails.at(-1)!));
}

describe('Gmail addresses', () => {
  it('are one account however they are spelled, and mail goes to the normalized address', async () => {
    const id = gmailUser();
    const email = `${id}@gmail.com`;
    const first = await signIn(email);
    // Three sign-ins: the per-address limit of 3 a minute counts every spelling together.
    for (const spelling of [`${id}+santa@gmail.com`, `${id.toUpperCase()}+x@GoogleMail.com`]) {
      expect((await signInAs(spelling, email)).body.user).toEqual({ id: first.id, name: '', email, joinedAt: expect.any(String) });
    }
    expect(await mailbox(`${id}+santa@gmail.com`)).toEqual([]);
  });

  // The limit counts in one-minute windows; a run that crosses into the next one sees the count start again.
  it('share one per-address rate limit', { retry: 2 }, async () => {
    const id = gmailUser();
    const statuses = [];
    for (const spelling of [`${id}@gmail.com`, `${id}+a@gmail.com`, `${id}+b@googlemail.com`, `${id.toUpperCase()}@gmail.com`, `${dotted(id)}@gmail.com`]) {
      statuses.push((await requestMagicLink(spelling, { ip: uniqueIp() })).status);
    }
    // The dotted spelling is another address, with a limit of its own.
    expect(statuses).toEqual([202, 202, 202, 429, 202]);
  });

  it('move an account made before addresses were normalized on its next sign-in, parties and all', async () => {
    const id = gmailUser();
    const typed = `${id}+santa@gmail.com`;
    const email = `${id}@gmail.com`;
    // The account as it was kept before: under the address as typed.
    const record = await env.USER.getByName(typed).ensure(typed);
    const old = { email: typed, id: nodeIdToStr({ kind: 'User', id: record.id }), token: await mintUserToken({ sub: nodeIdToStr({ kind: 'User', id: record.id }), email: typed, ver: 0 }) };
    const hosted = await createParty(old, 'Mine');
    const host = await signIn(uniqueEmail('host'));
    const joined = await createParty(host, 'Theirs');
    expect((await joinParty(old, joined, 'Me')).status).toBe(200);

    const entered = await signInAs(typed, email);
    expect(entered.body.user).toEqual({ id: old.id, name: 'Me', email, joinedAt: expect.any(String) });
    const moved = { email, id: old.id, token: entered.body.userToken as string };
    expect((await myParties(moved)).body.items.map(p => [p.code, p.isHost])).toEqual([[joined.code, false], [hosted.code, true]]);
    expect((await me(old)).status).toBe(401);
    expect((await viewParty(hosted.code, moved)).body).toMatchObject({ isHost: true, isJoined: true });

    // The parties now write to the normalized address: the draw notice arrives there.
    await drawParty(host, joined);
    expect(await settleParty(joined.code)).toBe(0);
    expect((await viewParty(joined.code, moved)).body.target).toEqual({ name: '' });
    expect((await mailbox(email)).length).toBe(2);

    // Signing in again finds the moved account directly.
    expect((await signInAs(`${id}+again@gmail.com`, email)).body.user.id).toBe(old.id);
  });

  it('move an account kept without the dots to the dotted address it signs in with', async () => {
    const id = gmailUser();
    const email = `${dotted(id)}@gmail.com`;
    const old = await signIn(`${id}@gmail.com`);
    const party = await createParty(old, 'Mine');

    const entered = await signInAs(email, email);
    expect(entered.body.user).toEqual({ id: old.id, name: '', email, joinedAt: expect.any(String) });
    const moved = { email, id: old.id, token: entered.body.userToken as string };
    expect((await myParties(moved)).body.items.map(p => p.code)).toEqual([party.code]);
    expect((await me(old)).status).toBe(401);
  });
});
