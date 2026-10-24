import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { nodeIdToStr } from 'src/utils/strings/nodeId';

import {
  CLOSE_PARTY, LEAVE_PARTY, PARTY, Person, createParty, gql, joinParty, mailbox, mintUserToken, settleParty,
  signInWithMagicLink, uniqueEmail,
} from './support';

async function partyOf(size: number, name = 'Draw party') {
  const host = await signInWithMagicLink(uniqueEmail('host'));
  const party = await createParty(host, name);
  const guests: Person[] = [];
  for (let i = 1; i < size; i++) {
    const guest = await signInWithMagicLink(uniqueEmail(`guest${i}`));
    await joinParty(guest, party, `Guest ${i}`);
    guests.push(guest);
  }
  return { host, guests, party, everyone: [host, ...guests] };
}

describe('the draw', () => {
  it('gives everyone exactly one person to gift, never themselves', async () => {
    for (const size of [2, 3, 7]) {
      const { host, party, everyone } = await partyOf(size);
      const closed = (await gql(CLOSE_PARTY, { party: party.id }, { token: host.token })).data.parties.closeParty;
      expect(closed).toMatchObject({ status: 'ok', node: { isClosed: true } });

      const targets = [];
      for (const p of everyone) {
        const view = (await gql(PARTY, { code: party.code }, { token: p.token })).data.party;
        expect(view.isClosed).toBe(true);
        expect(view.target).not.toBeNull();
        expect(view.target.id).not.toBe(p.id);
        targets.push(view.target.id);
      }
      expect(new Set(targets)).toEqual(new Set(everyone.map(p => p.id)));
    }
  });

  it('shows each target with the name they joined under', async () => {
    const { host, guests, party } = await partyOf(2);
    await gql(CLOSE_PARTY, { party: party.id }, { token: host.token });
    const hostView = (await gql(PARTY, { code: party.code }, { token: host.token })).data.party;
    expect(hostView.target).toEqual({ id: guests[0].id, name: 'Guest 1' });
  });

  it('keeps the target private: other people see only their own', async () => {
    const { host, party } = await partyOf(3);
    await gql(CLOSE_PARTY, { party: party.id }, { token: host.token });
    const stranger = await signInWithMagicLink(uniqueEmail('stranger'));
    const anonymous = (await gql(PARTY, { code: party.code })).data.party;
    const outsider = (await gql(PARTY, { code: party.code }, { token: stranger.token })).data.party;
    expect(anonymous.target).toBeNull();
    expect(outsider.target).toBeNull();
  });
});

describe('after closing', () => {
  it('cannot be joined, left or closed again', async () => {
    const { host, guests, party } = await partyOf(3);
    await gql(CLOSE_PARTY, { party: party.id }, { token: host.token });

    const late = await signInWithMagicLink(uniqueEmail('late'));
    expect(await joinParty(late, party, 'Late')).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'party' }] });

    const leave = (await gql(LEAVE_PARTY, { party: party.id }, { token: guests[0].token })).data.parties.leaveParty;
    expect(leave).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'party' }] });

    const again = (await gql(CLOSE_PARTY, { party: party.id }, { token: host.token })).data.parties.closeParty;
    expect(again).toMatchObject({ status: 'error', userErrors: [{ messages: ['Party is already closed.'] }] });
  });

  it('lets a member rejoin harmlessly (they are already in)', async () => {
    const { host, guests, party } = await partyOf(2);
    await gql(CLOSE_PARTY, { party: party.id }, { token: host.token });
    expect(await joinParty(guests[0], party, 'Guest 1')).toMatchObject({ status: 'ok', node: { isClosed: true } });
  });
});

describe('notification emails', () => {
  it('emails every participant once, with the party name and link', async () => {
    const { host, party, everyone } = await partyOf(4, 'Tom & Jerry <3');
    await gql(CLOSE_PARTY, { party: party.id }, { token: host.token });
    expect(await settleParty(party.code)).toBe(0);

    for (const p of everyone) {
      const notifications = (await mailbox(p.email)).filter(m => m.subject === 'Tom & Jerry <3');
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
    const host = await signInWithMagicLink(uniqueEmail('host'));
    const party = await createParty(host, 'Flaky mail');
    const ok = await signInWithMagicLink(uniqueEmail('ok'));
    await joinParty(ok, party, 'Ok');

    // The magic link to this address can't be delivered, so mint the session directly.
    const flakyEmail = `fail+${uniqueEmail('flaky')}`;
    const flakyUser = await env.USER.getByName(flakyEmail).ensure(flakyEmail);
    const flaky = { email: flakyEmail, id: nodeIdToStr({ kind: 'User', id: flakyUser.id }), token: '' };
    flaky.token = await mintUserToken({ sub: flaky.id, email: flakyEmail });
    await joinParty(flaky, party, 'Flaky');

    const closed = (await gql(CLOSE_PARTY, { party: party.id }, { token: host.token })).data.parties.closeParty;
    expect(closed.status).toBe('ok');

    expect(await settleParty(party.code, 5)).toBe(1);
    expect((await mailbox(host.email)).some(m => m.subject === 'Flaky mail')).toBe(true);
    expect((await mailbox(ok.email)).some(m => m.subject === 'Flaky mail')).toBe(true);
    expect((await gql(PARTY, { code: party.code }, { token: flaky.token })).data.party.target).not.toBeNull();
  });
});
