import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';

import { adoptTypedAccount } from 'src/api/account';
import { bodies } from 'src/api/schemas';
import { EnterRequestToken } from 'src/api/types';
import { canonicalEmail, undottedGmail } from 'src/utils/email';

import { jwt, mailer, request, signIn, testEnv, uniqueEmail } from './helpers';

/** A fresh Gmail user name, with no dots or dashes. */
const gmailUser = () => uniqueEmail('g').split('@')[0].replaceAll('-', '');
/** The same Gmail user name with a dot after its first letter. */
const dotted = (id: string) => `${id.slice(0, 1)}.${id.slice(1)}`;

const tokenFrom = (text: string, path: string) => new RegExp(`/${path}#([\\w-]+(?:\\.[\\w-]*){4})`).exec(text)![1];
const signInLink = (payload: { email: string; typed?: string }) =>
  jwt().issueToken<EnterRequestToken>('EnterRequest', { ...payload, jti: crypto.randomUUID() } as EnterRequestToken, { ttl: 300 });
const enter = (token: string) => request('POST', '/v1/auth/session', { body: { token } });

describe('canonicalEmail', () => {
  it('lowercases every address; for Gmail it also drops +tags and uses gmail.com, but keeps the dots', () => {
    expect(canonicalEmail(' Some.One+Tag@Example.COM ')).toBe('some.one+tag@example.com');
    expect(canonicalEmail('John.Doe+santa@Gmail.com')).toBe('john.doe@gmail.com');
    expect(canonicalEmail('j.o.h.n.d.o.e@GoogleMail.com')).toBe('j.o.h.n.d.o.e@gmail.com');
    expect(canonicalEmail('johndoe+a+b@gmail.com')).toBe('johndoe@gmail.com');
    expect(canonicalEmail('john.doe@mail.gmail.com')).toBe('john.doe@mail.gmail.com');
    expect(canonicalEmail('no-at-sign')).toBe('no-at-sign');
  });

  it('gives the dot-less spelling of a dotted Gmail address, where older accounts may be kept', () => {
    expect(undottedGmail('john.doe@gmail.com')).toBe('johndoe@gmail.com');
    expect(undottedGmail('johndoe@gmail.com')).toBeNull();
    expect(undottedGmail('john.doe@example.com')).toBeNull();
  });

  it('is the email request bodies give back, along with the address as typed', () => {
    expect(v.parse(bodies.magicLink, { email: ' John.Doe+Santa@GoogleMail.com ' }))
      .toEqual({ email: 'john.doe@gmail.com', typed: 'john.doe+santa@googlemail.com', party: undefined });
    expect(v.parse(bodies.emailChange, { email: 'A@B.example' })).toEqual({ email: 'a@b.example', typed: 'a@b.example' });
    // Nothing is left of these once normalized.
    expect(v.safeParse(bodies.magicLink, { email: '+santa@gmail.com' }).success).toBe(false);
  });
});

describe('signing in with a Gmail address', () => {
  it('mails the link to the normalized address and signs in to one account, however it is spelled', async () => {
    const id = gmailUser();
    const email = `${dotted(id)}@gmail.com`;
    const { sent, EMAIL } = mailer();
    for (const spelling of [`${dotted(id)}+santa@GoogleMail.com`, email]) {
      expect((await request('POST', '/v1/auth/magic-link', { body: { email: spelling }, env: testEnv({ EMAIL }) })).status).toBe(202);
    }
    expect(sent.map(m => m.to)).toEqual([email, email]);
    const [spelled, plain] = sent.map(m => tokenFrom(m.text, 'enter/link'));
    expect(await jwt().jwtVerify<EnterRequestToken>(spelled, 'EnterRequest')).toMatchObject({ email, typed: `${dotted(id)}+santa@googlemail.com` });
    expect(await jwt().jwtVerify<EnterRequestToken>(plain, 'EnterRequest')).not.toHaveProperty('typed');

    const first = await enter(spelled);
    expect(first).toMatchObject({ status: 200, body: { user: { name: '', email } } });
    expect((await enter(plain)).body.user).toEqual(first.body.user);
  });

  it('moves an account kept under the address as typed to the normalized one, with its parties', async () => {
    const id = gmailUser();
    const typed = `${id}+santa@gmail.com`;
    const old = await signIn(typed, 'Old');
    const party = (await request('POST', '/v1/parties', { token: old.token, body: { name: 'Kept' } })).body;

    const entered = await enter(await signInLink({ email: `${id}@gmail.com`, typed }));
    expect(entered).toMatchObject({ status: 200, body: { user: { id: old.nodeId, name: 'Old', email: `${id}@gmail.com` } } });
    expect((await request('GET', '/v1/me/parties', { token: entered.body.userToken })).body.items).toMatchObject([{ code: party.code, isHost: true }]);
    expect((await request('GET', '/v1/me', { token: old.token })).status).toBe(401);
    expect(await env.USER.getByName(typed).get()).toBeNull();
  });

  it('does the same for links sent before addresses were normalized', async () => {
    const id = gmailUser();
    const typed = `${id}+old@gmail.com`;
    const old = await signIn(typed);
    expect((await enter(await signInLink({ email: typed }))).body.user).toEqual({ id: old.nodeId, name: '', email: `${id}@gmail.com` });
  });

  it('moves an account kept without the dots to the dotted address it is signed in with', async () => {
    const id = gmailUser();
    const old = await signIn(`${id}@gmail.com`, 'Old');
    const entered = await enter(await signInLink({ email: `${dotted(id)}@gmail.com` }));
    expect(entered).toMatchObject({ status: 200, body: { user: { id: old.nodeId, name: 'Old', email: `${dotted(id)}@gmail.com` } } });
    expect((await request('GET', '/v1/me', { token: old.token })).status).toBe(401);
    expect(await env.USER.getByName(`${id}@gmail.com`).get()).toBeNull();
  });

  it('leaves an account under the typed address alone when the normalized address has its own', async () => {
    const id = gmailUser();
    const typed = `${id}+old@gmail.com`;
    const old = await signIn(typed);
    const current = await signIn(`${id}@gmail.com`);
    expect((await enter(await signInLink({ email: `${id}@gmail.com`, typed }))).body.user.id).toBe(current.nodeId);
    expect(await env.USER.getByName(typed).get()).toMatchObject({ id: old.id });
  });
});

describe('adoptTypedAccount', () => {
  const user = { id: 'u1', email: 'a.b@gmail.com', name: '', joined: 0, tokenVersion: 0 };
  const fakeEnv = (started: unknown, current: unknown = null) => {
    const abort = vi.fn();
    const fake = {
      USER: {
        getByName: (name: string) => ({
          get: async () => (name === 'ab@gmail.com' ? current : user),
          startAccountChange: async () => started,
          abortAccountChange: abort,
        }),
      },
      PARTY: { getByName: () => ({ changeMemberEmail: async () => { throw new Error('down'); } }) },
    };
    return { abort, env: fake as unknown as typeof env };
  };
  const adopt = (e: typeof env) => adoptTypedAccount(e, ['a.b@gmail.com'], 'ab@gmail.com', 'jti', Date.now() + 60_000);

  it('signs in as usual when there is nothing to move, or it went away in the meantime', async () => {
    await expect(adopt(fakeEnv(null, user).env)).resolves.toBe('none');
    await expect(adopt(fakeEnv({ ok: false, reason: 'gone' }).env)).resolves.toBe('gone');
  });

  it('refuses the sign-in when the move has to be tried again, so no empty account starts instead', async () => {
    await expect(adopt(fakeEnv({ ok: false, reason: 'used' }).env)).rejects.toMatchObject({ code: 'link_used' });
    for (const reason of ['busy', 'repeat']) {
      await expect(adopt(fakeEnv({ ok: false, reason, outcome: null }).env)).rejects.toMatchObject({ code: 'account_busy' });
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unreachable = fakeEnv({ ok: true, user, parties: ['QWERTYUI'] });
    await expect(adopt(unreachable.env)).rejects.toMatchObject({ code: 'not_finished' });
    expect(unreachable.abort).toHaveBeenCalledWith('jti');
    error.mockRestore();
  });
});

describe('changing to a Gmail address', () => {
  const ask = (token: string, email: string, e?: typeof env) => request('POST', '/v1/me/email-change', { token, body: { email }, env: e });

  it('treats every spelling as one address, but a dot makes another one', async () => {
    const id = gmailUser();
    const who = await signIn(`${id}@gmail.com`);
    expect(await ask(who.token, `${id}+x@googlemail.com`)).toMatchObject({ status: 400, body: { error: { message: "That's already your email." } } });
    const dots = mailer();
    expect((await ask(who.token, `${dotted(id)}@gmail.com`, testEnv({ EMAIL: dots.EMAIL }))).status).toBe(202);
    expect(dots.sent.map(m => m.to)).toEqual([`${dotted(id)}@gmail.com`, `${id}@gmail.com`]);

    const other = gmailUser();
    await signIn(`${dotted(other)}@gmail.com`);
    const notified = mailer();
    expect((await ask(who.token, `${dotted(other)}+x@googlemail.com`, testEnv({ EMAIL: notified.EMAIL }))).status).toBe(202);
    expect(notified.sent[0]).toMatchObject({ to: `${dotted(other)}@gmail.com`, subject: 'Someone tried to use your email on Anonymous Santa Clauses' });

    const free = gmailUser();
    const { sent, EMAIL } = mailer();
    expect((await ask(who.token, `${free}+santa@gmail.com`, testEnv({ EMAIL }))).status).toBe(202);
    expect(sent[0].to).toBe(`${free}@gmail.com`);
  });
});
