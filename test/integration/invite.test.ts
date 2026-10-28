import { describe, expect, it } from 'vitest';

import {
  browserKey, call, createParty, joinParty, linkToken, mailbox, newKey, settleParty, signIn, uniqueEmail, viewParty,
} from './support';

const invite = (host: { token: string }, code: string, emails: string[]) =>
  call('POST', '/v1/parties/invite', { token: host.token, body: { code, emails } });

/** The invite email's link token: the party's own page, with the token after "#". */
async function invitedLink(email: string, code: string) {
  const [mail] = (await mailbox(email)).filter(m => m.subject === "You're invited to a Secret Santa party!");
  return linkToken(mail, `p/${code}/`);
}

describe('taking up an emailed invite', () => {
  it('signs the invited person in and joins them, with one click and their name', async () => {
    const host = await signIn(uniqueEmail('host'));
    await call('PATCH', '/v1/me', { token: host.token, body: { name: 'Host' } });
    const party = await createParty(host, 'Office party', 'Jingle bells');
    const email = uniqueEmail('invited');
    expect((await invite(host, party.code, [email])).body.invited).toEqual([email]);
    await settleParty(party.code);
    const token = await invitedLink(email, party.code);

    const key = await browserKey();
    const taken = await call('POST', '/v1/auth/invite', { key: newKey(), body: { token, key: key.jwk, name: 'Elf', password: 'Jingle bells' } });
    expect(taken).toMatchObject({ status: 200, body: { party: party.code, user: { email, name: '' } } });

    // The session works with the browser's key, and the person is in.
    const seen = await call('POST', '/v1/parties/lookup', { body: { code: party.code }, token: taken.body.userToken, browserKey: key });
    expect(seen.body).toMatchObject({ isJoined: true });
    expect((await viewParty(party.code, host)).body.participants).toEqual(['Elf', 'Host']);
  });

  it('sends a member who opens their invite a sign-in link instead', async () => {
    const host = await signIn(uniqueEmail('host'));
    const party = await createParty(host);
    const email = uniqueEmail('member');
    await invite(host, party.code, [email]);
    await settleParty(party.code);
    const guest = await signIn(email);
    await joinParty(guest, party, 'Guest');

    expect(await call('POST', '/v1/auth/invite', { key: newKey(), body: { token: await invitedLink(email, party.code), name: 'Guest' } }))
      .toMatchObject({ status: 202, body: { ok: true } });
    expect((await mailbox(email)).at(-1)!.text).toContain('https://gnomik.me/enter/link#');
  });
});
