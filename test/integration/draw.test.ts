import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { nodeIdToStr } from 'src/utils/strings/nodeId';

import {
  Person, apiError, call, createParty, drawParty, joinParty, leaveParty, mailbox, mintUserToken, settleParty, signIn,
  uniqueEmail, viewParty,
} from './support';

/** A party with `size` people: the host (named "Host") and guests named "Guest 1", "Guest 2", ... */
async function partyOf(size: number, name = 'Draw party') {
  const host = await signIn(uniqueEmail('host'));
  await call('PATCH', '/v1/me', { token: host.token, body: { name: 'Host' } });
  const party = await createParty(host, name);
  const guests: Person[] = [];
  for (let i = 1; i < size; i++) {
    const guest = await signIn(uniqueEmail(`guest${i}`));
    await joinParty(guest, party, `Guest ${i}`);
    guests.push(guest);
  }
  return { host, guests, party, everyone: [host, ...guests], names: ['Host', ...guests.map((_, i) => `Guest ${i + 1}`)] };
}

describe('the draw', () => {
  it('gives everyone exactly one person to gift, never themselves', async () => {
    for (const size of [2, 3, 7]) {
      const { host, party, everyone, names } = await partyOf(size);
      const closed = await drawParty(host, party);
      expect(closed).toMatchObject({ status: 200, body: { isClosed: true } });

      const targets = [];
      for (const [i, p] of everyone.entries()) {
        const { body: view } = await viewParty(party.code, p);
        expect(view.isClosed).toBe(true);
        expect(view.target).not.toBeNull();
        expect(view.target!.name).not.toBe(names[i]);
        targets.push(view.target!.name);
      }
      expect(new Set(targets)).toEqual(new Set(names));
    }
  });

  it('shows each target by the name they joined under, and nothing else about them', async () => {
    const { host, party } = await partyOf(2);
    await drawParty(host, party);
    expect((await viewParty(party.code, host)).body.target).toEqual({ name: 'Guest 1' });
  });

  it('keeps the target private: other people see only their own', async () => {
    const { host, party } = await partyOf(3);
    await drawParty(host, party);
    const stranger = await signIn(uniqueEmail('stranger'));
    expect((await viewParty(party.code)).body.target).toBeNull();
    expect((await viewParty(party.code, stranger)).body.target).toBeNull();
  });

  it('draws once: rolling again answers with the same draw and mails nobody again', async () => {
    const { host, party, everyone } = await partyOf(3);
    const first = await drawParty(host, party);
    const before = await Promise.all(everyone.map(async p => (await viewParty(party.code, p)).body.target));
    await settleParty(party.code);

    const again = await drawParty(host, party);
    expect(again).toEqual(first);
    await settleParty(party.code);
    expect(await Promise.all(everyone.map(async p => (await viewParty(party.code, p)).body.target))).toEqual(before);
    for (const p of everyone) {
      expect((await mailbox(p.email)).filter(m => m.subject === 'Draw party: the dice are rolled!')).toHaveLength(1);
    }
  });
});

describe('after closing', () => {
  it('cannot be joined or left', async () => {
    const { host, guests, party } = await partyOf(3);
    await drawParty(host, party);

    const late = await signIn(uniqueEmail('late'));
    expect(await joinParty(late, party, 'Late')).toMatchObject({ status: 409, body: apiError('conflict', undefined, 'party') });
    expect(await leaveParty(guests[0], party)).toMatchObject({ status: 409, body: apiError('conflict', undefined, 'party') });
  });

  it('lets a member rejoin harmlessly (they are already in)', async () => {
    const { host, guests, party } = await partyOf(2);
    await drawParty(host, party);
    expect(await joinParty(guests[0], party, 'Guest 1')).toMatchObject({ status: 200, body: { isClosed: true } });
  });
});

describe('notification emails', () => {
  it('emails every participant once, with the party name and link', async () => {
    const { host, party, everyone } = await partyOf(4, 'Tom & Jerry <3');
    await drawParty(host, party);
    expect(await settleParty(party.code)).toBe(0);

    for (const p of everyone) {
      const notifications = (await mailbox(p.email)).filter(m => m.subject === 'Tom & Jerry <3: the dice are rolled!');
      expect(notifications).toHaveLength(1);
      const [mail] = notifications;
      expect(mail.to).toEqual([p.email]);
      expect(mail.html).toContain(`href="https://gnomik.me/p/${party.code}/"`);
      expect(mail.html).not.toContain('Tom & Jerry <3');
      expect(mail.text).toContain(`https://gnomik.me/p/${party.code}/`);
      expect(mail.html).toContain('https://api.test/email/party.gif');
      expect(`${mail.html} ${mail.text}`).not.toMatch(/unsubscribe/i);
    }
  });

  it('keeps retrying a failed notification without blocking the others or the draw', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host, 'Flaky mail');
    const ok = await signIn(uniqueEmail('ok'));
    await joinParty(ok, party, 'Ok');

    // The magic link to this address can't be delivered, so mint the session directly.
    const flakyEmail = `fail+${uniqueEmail('flaky')}`;
    const flakyUser = await env.USER.getByName(flakyEmail).ensure(flakyEmail);
    const flaky = { email: flakyEmail, id: nodeIdToStr({ kind: 'User', id: flakyUser.id }), token: '' };
    flaky.token = await mintUserToken({ sub: flaky.id, email: flakyEmail });
    await joinParty(flaky, party, 'Flaky');

    expect((await drawParty(host, party)).status).toBe(200);

    expect(await settleParty(party.code, 5)).toBe(1);
    expect((await mailbox(host.email)).some(m => m.subject === 'Flaky mail: the dice are rolled!')).toBe(true);
    expect((await mailbox(ok.email)).some(m => m.subject === 'Flaky mail: the dice are rolled!')).toBe(true);
    expect((await viewParty(party.code, flaky)).body.target).not.toBeNull();
  });
});
