import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';

import { makeSession } from 'src/api/context';
import { ApiError, fail } from 'src/api/errors';
import { keyHash, readBody } from 'src/api/input';
import { bodies, encodeCursor, headers, party as partyJson, partyQuery, partyPage, queries, tokens, user as userJson } from 'src/api/schemas';
import { authenticate } from 'src/api/session';
import { EnterRequestToken, UserToken } from 'src/api/types';
import { MAX_PARTY_MEMBERS, PartyDO } from 'src/do/PartyDO';
import { nodeIdToStr, strToNodeId } from 'src/utils/strings/nodeId';

import { denied, jwt, mailer, request, sessionToken, signIn, testEnv, uniqueEmail } from './helpers';

const key = () => crypto.randomUUID();
const DAY = 24 * 60 * 60 * 1000;

/** The token from the last link of `path` sent (after a `/`, or after `#` for links that keep it out of the URL path). */
const tokenFrom = (text: string, path: string) => new RegExp(`/${path}[/#]([\\w-]+\\.[\\w-]+\\.[\\w-]+)`).exec(text)![1];

const createParty = (token: string, name = 'Party', options: { password?: string; key?: string; env?: typeof env } = {}) =>
  request('POST', '/v1/parties', { token, key: options.key, env: options.env, body: { name, ...(options.password ? { password: options.password } : {}) } });

const join = (token: string, code: string, name = 'Guest', password?: string) =>
  request('POST', '/v1/parties/join', { token, body: { code: code, name, ...(password ? { password } : {}) } });

describe('POST /v1/auth/magic-link', () => {
  it('emails a link with a fresh id each time, to the lowercased address, carrying a valid party code', async () => {
    const host = await signIn();
    const { body: party } = await createParty(host.token);
    const { sent, EMAIL } = mailer();
    const email = uniqueEmail();
    for (const body of [{ email: email.toUpperCase() }, { email, party: party.code.toLowerCase() }]) {
      expect(await request('POST', '/v1/auth/magic-link', { body, env: testEnv({ EMAIL }) })).toMatchObject({ status: 202, body: { ok: true } });
    }
    expect(sent.map(m => m.to)).toEqual([email, email]);
    const [first, second] = await Promise.all(sent.map(m => jwt().jwtVerify<EnterRequestToken>(tokenFrom(m.text, 'enter'), 'EnterRequest')));
    expect(first.jti).not.toBe(second.jti);
    expect(second.party).toBe(party.code);
    expect(first.party).toBeUndefined();
  });

  it('refuses an unknown party, either rate limit, and a failed send', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await request('POST', '/v1/auth/magic-link', { body: { email: uniqueEmail(), party: 'QQQQQ' } })).toMatchObject({ status: 404 });
    for (const limits of [{ ENTER_RATE_LIMIT_IP: denied }, { ENTER_RATE_LIMIT_EMAIL: denied }]) {
      expect(await request('POST', '/v1/auth/magic-link', { body: { email: uniqueEmail() }, env: testEnv(limits) })).toMatchObject({
        status: 429, body: { error: { code: 'rate_limited', field: 'email' } },
      });
    }
    const { EMAIL } = mailer(() => true);
    expect(await request('POST', '/v1/auth/magic-link', { body: { email: uniqueEmail() }, env: testEnv({ EMAIL }) })).toMatchObject({
      status: 503, body: { error: { code: 'unavailable', message: "We couldn't send the magic link right now. Please try again in a few minutes." } },
    });
    expect(error).toHaveBeenCalledWith('Unable to send the magic link', 'Error: down');
    error.mockRestore();
  });

  it('sends once per key, frees the key when sending fails, and lets only one of two simultaneous repeats send', async () => {
    const email = uniqueEmail();
    const k = key();
    const { sent, EMAIL } = mailer();
    const ask = (e = testEnv({ EMAIL })) => request('POST', '/v1/auth/magic-link', { key: k, body: { email }, env: e });
    await Promise.all([ask(), ask(), ask()]);
    await ask();
    expect(sent).toHaveLength(1);

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const other = uniqueEmail();
    const failing = mailer(() => true);
    const working = mailer();
    expect((await request('POST', '/v1/auth/magic-link', { key: k, body: { email: other }, env: testEnv({ EMAIL: failing.EMAIL }) })).status).toBe(503);
    expect((await request('POST', '/v1/auth/magic-link', { key: k, body: { email: other }, env: testEnv({ EMAIL: working.EMAIL }) })).status).toBe(202);
    expect(working.sent).toHaveLength(1);
    error.mockRestore();
  });
});

describe('POST /v1/auth/session', () => {
  const link = (payload: Partial<EnterRequestToken>, ttl?: number) => jwt().issueToken<EnterRequestToken>('EnterRequest', payload as EnterRequestToken, ttl === undefined ? {} : { ttl });

  it('signs in once per link, answering a repeat of the same request with the same user', async () => {
    const email = uniqueEmail();
    const token = await link({ email: email.toUpperCase(), jti: crypto.randomUUID() }, 60);
    const k = key();
    const first = await request('POST', '/v1/auth/session', { key: k, body: { token } });
    expect(first).toMatchObject({ status: 200, body: { user: { name: '', email } } });
    expect(await jwt().jwtVerify<UserToken>(first.body.userToken, 'UserToken')).toMatchObject({ sub: first.body.user.id, email, ver: 0 });
    expect((await request('POST', '/v1/auth/session', { key: k, body: { token } })).body.user).toEqual(first.body.user);
    expect(await request('POST', '/v1/auth/session', { body: { token } })).toMatchObject({ status: 409, body: { error: { code: 'link_used' } } });
  });

  it('refuses tokens that are invalid, of another kind, or missing an id, expiry or email', async () => {
    const tokens = [
      'garbage',
      await link({ email: uniqueEmail() }, 60),
      await link({ email: uniqueEmail(), jti: 'x' }),
      await link({ jti: 'x', email: 7 as unknown as string }, 60),
      await jwt().issueToken<UserToken>('UserToken', { sub: 'x', email: uniqueEmail() }, { ttl: 60 }),
    ];
    for (const token of tokens) {
      expect(await request('POST', '/v1/auth/session', { body: { token } })).toMatchObject({ status: 400, body: { error: { code: 'invalid_link', field: 'token' } } });
    }
  });
});

describe('GET and PATCH /v1/me', () => {
  it('reads and renames the signed-in user', async () => {
    const who = await signIn(uniqueEmail(), 'Old');
    expect(await request('GET', '/v1/me', { token: who.token })).toEqual(expect.objectContaining({
      status: 200, body: { id: who.nodeId, name: 'Old', email: who.email },
    }));
    expect((await request('PATCH', '/v1/me', { token: who.token, body: { name: '  New   name ' } })).body).toEqual({ id: who.nodeId, name: 'New name', email: who.email });
    expect((await env.USER.getByName(who.email).get())!.name).toBe('New name');
  });

  it('answers 401 for a revoked session, and checks the session before the input', async () => {
    const who = await signIn();
    await env.USER.getByName(who.email).tombstone();
    expect((await request('GET', '/v1/me', { token: who.token })).status).toBe(401);
    expect((await request('PATCH', '/v1/me', { token: who.token, body: { name: 'Back' } })).status).toBe(401);
    expect((await request('PATCH', '/v1/me', { body: { name: '' } })).status).toBe(401);
  });
});

describe('POST /v1/me/sign-out', () => {
  it('ends every session of the account, this one included; a repeat finds it gone', async () => {
    const who = await signIn();
    const otherDevice = await sessionToken(who.id, who.email, 0);
    expect(await request('POST', '/v1/me/sign-out', { token: who.token })).toMatchObject({ status: 200, body: { ok: true } });
    for (const token of [who.token, otherDevice]) {
      expect((await request('GET', '/v1/me', { token })).status).toBe(401);
    }
    expect(await request('POST', '/v1/me/sign-out', { token: who.token })).toMatchObject({ status: 401, body: { error: { code: 'unauthenticated' } } });
    expect(await env.USER.getByName(who.email).get()).toMatchObject({ id: who.id, tokenVersion: 1 });
    expect((await request('POST', '/v1/me/sign-out', { token: who.token, raw: '{"x":1}' })).status).toBe(400);
  });
});

describe('GET /v1/me/parties', () => {
  const addParties = async (email: string, parties: [string, number][]) =>
    await env.USER.getByName(email).apply(parties.map(([slug, createdAt]) => ({
      type: 'addParty' as const, party: { slug, name: slug, createdAt, isHost: false, isProtected: false, isClosed: false, closedAt: null },
    })));
  const page = async (token: string, query = '') => (await request('GET', `/v1/me/parties${query}`, { token })).body;

  it('pages newest first without skipping or repeating parties created together', async () => {
    const who = await signIn();
    await addParties(who.email, [['QQQBA', 1], ['QQQBB', 2], ['QQQBC', 2], ['QQQBD', 2], ['QQQBE', 3]]);
    const first = await page(who.token, '?first=2');
    expect([first.items.map((p: any) => p.code), first.hasMore]).toEqual([['QQQBE', 'QQQBD'], true]);
    const second = await page(who.token, `?first=2&after=${first.endCursor}`);
    expect(second.items.map((p: any) => p.code)).toEqual(['QQQBC', 'QQQBB']);
    const third = await page(who.token, `?first=2&after=${second.endCursor}`);
    expect(third).toMatchObject({ items: [{ code: 'QQQBA', isJoined: true }], hasMore: false });
    expect(await page(who.token, `?first=2&after=${third.endCursor}`)).toEqual({ items: [], hasMore: false, endCursor: null });
    expect((await page(who.token, '?first=100')).items).toHaveLength(5);
  });

  it('fills in old rows from their parties once, keeps going past parties that are gone, and keeps deleted ones marked', async () => {
    const host = await signIn(uniqueEmail(), 'Host');
    const { body: party } = await createParty(host.token, 'Stale');
    const { body: deleted } = await request('POST', '/v1/parties/delete', { body: { code: party.code }, token: host.token });
    await addParties(host.email, [['QQQDA', 1]]);
    await runInDurableObject(env.USER.getByName(host.email), async (_i, state) => {
      state.storage.sql.exec('UPDATE parties SET is_host = NULL, deleted_at = NULL');
    });
    expect(await page(host.token, '?first=1')).toMatchObject({ items: [{ code: party.code, deletedAt: deleted.deletedAt, isHost: true }], hasMore: true });
    expect(await env.USER.getByName(host.email).listParties(10)).toMatchObject([{ slug: party.code, isHost: true }, { slug: 'QQQDA', isHost: null }]);
    const rest = await page(host.token, `?first=1&after=${(await page(host.token, '?first=1')).endCursor}`);
    expect(rest).toMatchObject({ items: [], hasMore: false, endCursor: expect.any(String) });
  });

  it('answers 401 for a revoked session and 400 for bad paging', async () => {
    const who = await signIn();
    expect((await request('GET', '/v1/me/parties?first=0', { token: who.token })).status).toBe(400);
    await env.USER.getByName(who.email).tombstone();
    expect((await request('GET', '/v1/me/parties', { token: who.token })).status).toBe(401);
  });
});

describe('POST /v1/me/deletion and /v1/me/email-change', () => {
  it('sends one deletion link per key, refuses a revoked session, and frees the key on a rate limit or a failed send', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const who = await signIn();
    const k = key();
    const { sent, EMAIL } = mailer();
    for (let i = 0; i < 2; i++) {
      expect(await request('POST', '/v1/me/deletion', { token: who.token, key: k, env: testEnv({ EMAIL }) })).toMatchObject({ status: 202 });
    }
    expect(sent).toHaveLength(1);
    expect(tokenFrom(sent[0].text, 'profile/delete')).toBeTruthy();

    const k2 = key();
    expect((await request('POST', '/v1/me/deletion', { token: who.token, key: k2, env: testEnv({ ENTER_RATE_LIMIT_IP: denied }) })).status).toBe(429);
    expect((await request('POST', '/v1/me/deletion', { token: who.token, key: k2, env: testEnv({ EMAIL: mailer(() => true).EMAIL }) })).status).toBe(503);
    expect((await request('POST', '/v1/me/deletion', { token: who.token, key: k2, env: testEnv({ EMAIL }) })).status).toBe(202);
    expect(sent).toHaveLength(2);
    expect((await request('POST', '/v1/me/deletion', { token: who.token, raw: '{"x":"y"}' })).status).toBe(400);

    await env.USER.getByName(who.email).tombstone();
    expect((await request('POST', '/v1/me/deletion', { token: who.token })).status).toBe(401);
    error.mockRestore();
  });

  it('mails the change link to the new address and a notice to the old one, which may fail without failing the request', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const who = await signIn();
    const newEmail = uniqueEmail('new');
    const { sent, EMAIL } = mailer(to => to === who.email);
    expect(await request('POST', '/v1/me/email-change', { token: who.token, body: { email: newEmail.toUpperCase() }, env: testEnv({ EMAIL }) })).toMatchObject({ status: 202 });
    expect(sent.map(m => m.to)).toEqual([newEmail]);
    expect(error).toHaveBeenCalledWith('Unable to send a courtesy email', 'Error: down');
    error.mockRestore();
  });

  it('refuses the same address, a rate limit and a revoked session', async () => {
    const who = await signIn();
    const ask = (email: string, e?: typeof env) => request('POST', '/v1/me/email-change', { token: who.token, body: { email }, env: e });
    expect(await ask(who.email)).toMatchObject({ status: 400, body: { error: { message: "That's already your email." } } });
    expect(await ask(uniqueEmail(), testEnv({ ENTER_RATE_LIMIT_EMAIL: denied }))).toMatchObject({ status: 429 });
    await env.USER.getByName(who.email).tombstone();
    expect((await ask(uniqueEmail())).status).toBe(401);
  });
});

describe('POST /v1/me/deletion/confirm', () => {
  const deletionLink = (sub: string, email: string, jti = crypto.randomUUID(), ttl = 60) =>
    jwt().issueToken('AccountDeletion', { sub, email, jti, ver: 0 }, { ttl });

  /** Records what the user's Durable Object emails. */
  const userMail = async (email: string) => {
    const sent: { to: string; subject: string }[] = [];
    await runInDurableObject(env.USER.getByName(email), async (instance: unknown) => {
      const self = instance as { env: object };
      self.env = { ...self.env, EMAIL: { send: async (m: { to: string; subject: string }) => { sent.push({ to: m.to, subject: m.subject }); return { messageId: 'm' }; } } };
    });
    return sent;
  };

  it('checks a link without using it: the address while it works, the same errors as confirming after', async () => {
    const who = await signIn();
    const token = await deletionLink(who.nodeId, who.email);
    expect(await request('POST', '/v1/me/deletion/check', { body: { token } })).toEqual(expect.objectContaining({ status: 200, body: { email: who.email } }));
    expect(await request('POST', '/v1/me/deletion/check', { body: { token } })).toMatchObject({ status: 200 });
    expect((await request('POST', '/v1/me/deletion/confirm', { key: key(), body: { token } })).status).toBe(200);
    expect(await request('POST', '/v1/me/deletion/check', { body: { token } })).toMatchObject({ status: 409, body: { error: { code: 'link_used' } } });
    expect(await request('POST', '/v1/me/deletion/check', { body: { token: await deletionLink(who.nodeId, who.email) } }))
      .toMatchObject({ status: 400, body: { error: { message: 'This account no longer exists.' } } });
    expect(await request('POST', '/v1/me/deletion/check', { body: { token: 'garbage' } })).toMatchObject({ status: 400, body: { error: { code: 'invalid_link' } } });
  });

  it('refuses checking a link voided by signing out everywhere', async () => {
    const who = await signIn();
    const token = await deletionLink(who.nodeId, who.email);
    await runInDurableObject(env.USER.getByName(who.email), async (_instance, state) => {
      state.storage.sql.exec('UPDATE user SET token_version = token_version + 1');
    });
    expect(await request('POST', '/v1/me/deletion/check', { body: { token } }))
      .toMatchObject({ status: 400, body: { error: { message: expect.stringContaining('signed out everywhere') } } });
  });

  it('emails that it is officially over, once, after the account is gone', async () => {
    const who = await signIn();
    const sent = await userMail(who.email);
    const token = await deletionLink(who.nodeId, who.email);
    const k = key();
    expect((await request('POST', '/v1/me/deletion/confirm', { key: k, body: { token } })).status).toBe(200);
    expect((await request('POST', '/v1/me/deletion/confirm', { key: k, body: { token } })).status).toBe(200);
    // The alarm is set for now; run it in case it hasn't fired yet.
    await runDurableObjectAlarm(env.USER.getByName(who.email));
    expect(sent).toEqual([{ to: who.email, subject: 'Your Anonymous Ded Morozes account is deleted' }]);
    expect(await env.USER.getByName(who.email).pendingOutbox()).toBe(0);
  });

  it('retries the farewell email when sending fails, and drops it on a permanent error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const who = await signIn();
    const stub = env.USER.getByName(who.email);
    let failure: Error = Object.assign(new Error('try later'), { code: 'E_RATE_LIMIT_EXCEEDED' });
    await runInDurableObject(stub, async (instance: unknown) => {
      const self = instance as { env: object };
      self.env = { ...self.env, EMAIL: { send: async () => { throw failure; } } };
    });
    await stub.tombstone(true);
    await runDurableObjectAlarm(stub);
    expect(await stub.pendingOutbox()).toBe(1);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
      state.storage.sql.exec('UPDATE outbox SET next_attempt_at = 0');
    });
    failure = Object.assign(new Error('suppressed'), { code: 'E_RECIPIENT_SUPPRESSED' });
    await runInDurableObject(stub, async (instance: unknown) => (instance as { alarm: () => Promise<void> }).alarm());
    expect(await stub.pendingOutbox()).toBe(0);
    warn.mockRestore();
    error.mockRestore();
  });

  it('emails nothing when the account was already gone, or when it only moved', async () => {
    const who = await signIn();
    const stub = env.USER.getByName(who.email);
    await stub.tombstone();
    await stub.tombstone(true);
    expect(await stub.pendingOutbox()).toBe(0);
    await env.USER.getByName(uniqueEmail()).tombstone(true);
  });

  it('deletes the account, answers a repeat of the same request ok, and refuses anyone else', async () => {
    const who = await signIn();
    const token = await deletionLink(who.nodeId, who.email);
    const k = key();
    expect(await request('POST', '/v1/me/deletion/confirm', { key: k, body: { token } })).toEqual(expect.objectContaining({ status: 200, body: { ok: true } }));
    expect(await env.USER.getByName(who.email).get()).toBeNull();
    expect((await request('POST', '/v1/me/deletion/confirm', { key: k, body: { token } })).status).toBe(200);
    expect(await request('POST', '/v1/me/deletion/confirm', { body: { token } })).toMatchObject({ status: 409, body: { error: { code: 'link_used' } } });
  });

  it('keeps the account when a party can\'t be reached, and finishes when the link is opened again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const who = await signIn();
    const { body: party } = await createParty(who.token);
    const token = await deletionLink(who.nodeId, who.email);
    const broken = testEnv({ PARTY: { getByName: () => ({ forgetMember: async () => { throw new Error('down'); } }) } as any });
    expect(await request('POST', '/v1/me/deletion/confirm', { body: { token }, env: broken })).toMatchObject({ status: 503, body: { error: { code: 'not_finished' } } });
    expect(error).toHaveBeenCalledWith('Unable to remove a deleted account from a party', 'Error: down');
    expect(await env.USER.getByName(who.email).get()).not.toBeNull();
    expect((await request('POST', '/v1/me/deletion/confirm', { body: { token } })).status).toBe(200);
    expect((await request('GET', `/v1/parties?code=${party.code}`)).status).toBe(404);
    error.mockRestore();
  });

  it('refuses invalid links, links for someone else, and a busy account', async () => {
    const who = await signIn();
    const invalid = [
      'garbage',
      await deletionLink(who.nodeId, who.email, crypto.randomUUID(), -10),
      await jwt().issueToken('AccountDeletion', { sub: who.nodeId, email: who.email }, { ttl: 60 }),
      await jwt().issueToken('AccountDeletion', { sub: who.nodeId, email: who.email, jti: 'a' }),
      await jwt().issueToken('AccountDeletion', { sub: who.nodeId, jti: 'a' }, { ttl: 60 }),
      await deletionLink('%%%', who.email),
      await deletionLink(nodeIdToStr({ kind: 'Party', id: 'QWERT' }), who.email),
    ];
    for (const token of invalid) {
      expect(await request('POST', '/v1/me/deletion/confirm', { body: { token } })).toMatchObject({ status: 400, body: { error: { code: 'invalid_link' } } });
    }
    expect(await request('POST', '/v1/me/deletion/confirm', { body: { token: await deletionLink(nodeIdToStr({ kind: 'User', id: 'someone-else' }), who.email) } }))
      .toMatchObject({ status: 400, body: { error: { message: 'This account no longer exists.' } } });
    await env.USER.getByName(who.email).startAccountChange(who.id, 'other', Date.now() + 60_000);
    expect(await request('POST', '/v1/me/deletion/confirm', { body: { token: await deletionLink(who.nodeId, who.email) } }))
      .toMatchObject({ status: 409, body: { error: { code: 'account_busy' } } });
  });
});

describe('POST /v1/me/email-change to an address that has an account', () => {
  it('answers as for any address: that address gets a notice without a link, the current one the usual notice', async () => {
    const who = await signIn();
    const taken = await signIn();
    const free = uniqueEmail('free');
    const asked = async (email: string) => {
      const { sent, EMAIL } = mailer();
      const res = await request('POST', '/v1/me/email-change', { token: who.token, key: key(), body: { email }, env: testEnv({ EMAIL }) });
      return { res, sent };
    };
    const [toTaken, toFree] = [await asked(taken.email), await asked(free)];
    expect(toTaken.res).toEqual(toFree.res);
    expect(toTaken.sent.map(m => [m.to, m.subject])).toEqual([
      [taken.email, 'Someone tried to use your email on Anonymous Ded Morozes'],
      [who.email, 'Your Anonymous Ded Morozes email is being changed'],
    ]);
    expect(toTaken.sent[0].text).not.toMatch(/https?:/);
    expect(tokenFrom(toFree.sent[0].text, 'profile/email')).toBeTruthy();
    // Both notices to the current address carry a cancel link.
    expect([toTaken.sent[1].text, toFree.sent[1].text].map(text => Boolean(tokenFrom(text, 'profile/email/cancel')))).toEqual([true, true]);
    expect((await request('GET', '/v1/me', { token: taken.token })).body.email).toBe(taken.email);
  });
});

describe('POST /v1/me/email-change/cancel', () => {
  /** Asks to move `who` to a new address; returns the change link's token and the cancel link's token. */
  async function askToMove(who: { token: string }, newEmail = uniqueEmail('new')) {
    const { sent, EMAIL } = mailer();
    expect((await request('POST', '/v1/me/email-change', { token: who.token, key: key(), body: { email: newEmail }, env: testEnv({ EMAIL }) })).status).toBe(202);
    return { change: tokenFrom(sent[0].text, 'profile/email'), cancel: tokenFrom(sent[1].text, 'profile/email/cancel') };
  }
  const cancel = (token: string, k?: string) => request('POST', '/v1/me/email-change/cancel', { key: k, body: { token } });
  const confirm = (token: string) => request('POST', '/v1/me/email-change/confirm', { body: { token } });

  it('stops the change, signs out everywhere and keeps the email; a repeat of the same request answers ok again', async () => {
    const who = await signIn();
    const { change, cancel: cancelLink } = await askToMove(who);
    const k = key();
    expect(await cancel(cancelLink, k)).toMatchObject({ status: 200, body: { ok: true } });
    expect(await cancel(cancelLink, k)).toMatchObject({ status: 200 });
    expect(await cancel(cancelLink, key())).toMatchObject({ status: 409, body: { error: { code: 'link_used' } } });
    expect(await cancel(cancelLink)).toMatchObject({ status: 409 });

    expect(await confirm(change)).toMatchObject({ status: 409, body: { error: { code: 'link_used' } } });
    expect((await request('GET', '/v1/me', { token: who.token })).status).toBe(401);
    expect(await env.USER.getByName(who.email).get()).toMatchObject({ id: who.id, email: who.email, tokenVersion: 1 });
  });

  it('voids every other pending account link too', async () => {
    const who = await signIn();
    const first = await askToMove(who);
    const second = await askToMove(who);
    const { sent, EMAIL } = mailer();
    await request('POST', '/v1/me/deletion', { token: who.token, env: testEnv({ EMAIL }) });
    const deletion = tokenFrom(sent[0].text, 'profile/delete');

    expect((await cancel(first.cancel)).status).toBe(200);
    expect(await confirm(second.change)).toMatchObject({ status: 400, body: { error: { code: 'invalid_link', message: expect.stringMatching(/signed out everywhere/) } } });
    expect(await request('POST', '/v1/me/deletion/confirm', { body: { token: deletion } })).toMatchObject({ status: 400, body: { error: { code: 'invalid_link' } } });
    expect(await env.USER.getByName(who.email).get()).toMatchObject({ id: who.id });
  });

  it('is too late once the change was confirmed, and waits while it is running', async () => {
    const who = await signIn();
    const done = await askToMove(who);
    expect((await confirm(done.change)).status).toBe(200);
    expect(await cancel(done.cancel)).toMatchObject({ status: 409, body: { error: { code: 'link_used', message: expect.stringMatching(/already changed.*info@gnomik\.me/) } } });

    const other = await signIn();
    const running = await askToMove(other);
    const { jti } = await jwt().jwtVerify<{ jti: string }>(running.change, 'EmailChange');
    const stub = env.USER.getByName(other.email);
    await stub.startAccountChange(other.id, jti, Date.now() + 60_000, { outcome: 'somewhere@example.com' });
    expect(await cancel(running.cancel)).toMatchObject({ status: 409, body: { error: { code: 'account_busy' } } });
    // Another account change is running, not the one this link cancels.
    const held = await askToMove(await signIn());
    const { email: heldEmail, sub } = await jwt().jwtVerify<{ email: string; sub: string }>(held.cancel, 'EmailChangeCancel');
    await env.USER.getByName(heldEmail).startAccountChange(strToNodeId(sub)!.id, crypto.randomUUID(), Date.now() + 60_000);
    expect(await cancel(held.cancel)).toMatchObject({ status: 409, body: { error: { code: 'account_busy' } } });
  });

  it('refuses invalid links and accounts that are gone', async () => {
    expect(await cancel('garbage')).toMatchObject({ status: 400, body: { error: { code: 'invalid_link' } } });
    const who = await signIn();
    const { cancel: cancelLink } = await askToMove(who);
    await env.USER.getByName(who.email).tombstone();
    expect(await cancel(cancelLink)).toMatchObject({ status: 400, body: { error: { code: 'invalid_link', message: 'This account no longer exists.' } } });
  });
});

describe('POST /v1/me/email-change/confirm', () => {
  const changeLink = (who: { nodeId: string; email: string }, newEmail: string | undefined, ttl = 60) =>
    jwt().issueToken('EmailChange', { sub: who.nodeId, email: who.email, ...(newEmail === undefined ? {} : { newEmail }), jti: crypto.randomUUID(), ver: 0 }, { ttl });
  const confirm = (token: string, options: { key?: string; env?: typeof env } = {}) =>
    request('POST', '/v1/me/email-change/confirm', { body: { token }, ...options });

  it('moves the account and signs in; a repeat of the same request signs in again while the account is there', async () => {
    const who = await signIn(uniqueEmail(), 'Moving');
    const newEmail = uniqueEmail('new');
    const token = await changeLink(who, newEmail);
    const k = key();
    const moved = await confirm(token, { key: k });
    expect(moved).toMatchObject({ status: 200, body: { user: { id: who.nodeId, name: 'Moving', email: newEmail } } });
    expect(await jwt().jwtVerify<UserToken>(moved.body.userToken, 'UserToken')).toMatchObject({ ver: 1 });
    expect((await confirm(token, { key: k })).body.user).toEqual(moved.body.user);

    // Once the moved account is gone, a repeat has nothing to sign in to.
    await env.USER.getByName(newEmail).tombstone();
    expect(await confirm(token, { key: k })).toMatchObject({ status: 409, body: { error: { code: 'link_used' } } });
  });

  it('refuses a link without a new address, and a taken address before and during the change', async () => {
    const who = await signIn();
    expect(await confirm(await changeLink(who, undefined))).toMatchObject({ status: 400, body: { error: { code: 'invalid_link' } } });
    expect(await confirm(await changeLink(who, ''))).toMatchObject({ status: 400 });

    const taken = await signIn();
    expect(await confirm(await changeLink(who, taken.email))).toMatchObject({ status: 409, body: { error: { code: 'conflict', field: 'token' } } });

    // Someone signs up with the new address while the parties are being moved.
    const racing = uniqueEmail('racing');
    const raced = testEnv({
      USER: {
        getByName: (name: string) => {
          const stub = env.USER.getByName(name);
          return name === racing ? { get: () => stub.get(), receive: async () => null } : stub;
        },
      } as any,
    });
    expect(await confirm(await changeLink(who, racing), { env: raced })).toMatchObject({ status: 409, body: { error: { code: 'conflict' } } });
    expect(await env.USER.getByName(who.email).get()).toMatchObject({ id: who.id });
  });

  it('puts the parties back when one can\'t be moved', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const who = await signIn();
    const host = await signIn();
    const { body: mine } = await createParty(who.token, 'Mine');
    const { body: theirs } = await createParty(host.token, 'Theirs');
    await join(who.token, theirs.code);
    const newEmail = uniqueEmail('new');
    const broken = testEnv({
      PARTY: {
        getByName: (slug: string) => (slug === theirs.code ? { changeMemberEmail: async () => { throw new Error('down'); } } : env.PARTY.getByName(slug)),
      } as any,
    });
    expect(await confirm(await changeLink(who, newEmail), { env: broken })).toMatchObject({ status: 503, body: { error: { code: 'not_finished' } } });
    expect(await env.USER.getByName(who.email).get()).toMatchObject({ id: who.id });
    expect(await runInDurableObject(env.PARTY.getByName(mine.code), async (_i, state) =>
      state.storage.sql.exec<{ member_email: string }>('SELECT member_email FROM memberships').one().member_email)).toBe(who.email);
    error.mockRestore();
  });
});

describe('GET /v1/parties?code=', () => {
  it('shows members more than anyone else, and a revoked token only what anyone sees', async () => {
    const host = await signIn(uniqueEmail(), 'Host');
    const { body: party } = await createParty(host.token, 'Mine', { password: 'pw' });
    expect((await request('GET', `/v1/parties?code=${party.code.toLowerCase()}`, { token: host.token })).body).toMatchObject({ isHost: true, password: 'pw', participants: ['Host'] });
    const anonymous = (await request('GET', `/v1/parties?code=${party.code}`)).body;
    expect(anonymous).toMatchObject({ isHost: false, isJoined: false, password: null, participants: null });

    await env.USER.getByName(host.email).tombstone();
    expect((await request('GET', `/v1/parties?code=${party.code}`, { token: host.token })).body).toEqual(anonymous);
  });

  it('hides a deleted party from everyone but its host, revoked or not', async () => {
    const host = await signIn();
    const { body: party } = await createParty(host.token);
    await request('POST', '/v1/parties/delete', { body: { code: party.code }, token: host.token });
    expect((await request('GET', `/v1/parties?code=${party.code}`, { token: host.token })).body.deletedAt).toEqual(expect.any(String));
    expect((await request('GET', `/v1/parties?code=${party.code}`)).status).toBe(404);
    await env.USER.getByName(host.email).tombstone();
    expect((await request('GET', `/v1/parties?code=${party.code}`, { token: host.token })).status).toBe(404);
  });

  it('answers 404 for codes that aren\'t codes and 429 over the lookup limit', async () => {
    expect(await request('GET', '/v1/parties?code=nope!')).toMatchObject({ status: 404, body: { error: { code: 'not_found', field: 'party' } } });
    expect(await request('GET', '/v1/parties?code=QWERT', { env: testEnv({ PARTY_LOOKUP_RATE_LIMIT_IP: denied }) })).toMatchObject({ status: 429 });
  });
});

describe('POST /v1/parties', () => {
  it('creates a party, with or without a secret phrase, up to three open ones', async () => {
    const host = await signIn(uniqueEmail(), 'Host');
    expect(await createParty(host.token, 'Open')).toMatchObject({ status: 201, body: { isHost: true, isProtected: false } });
    expect(await createParty(host.token, 'Closed', { password: 'pw' })).toMatchObject({ status: 201, body: { isProtected: true, password: 'pw' } });
    await createParty(host.token, 'Third');
    expect(await createParty(host.token, 'Fourth')).toMatchObject({
      status: 409, body: { error: { message: 'You can host up to 3 open parties at a time. Close or delete one of them to start a new one.' } },
    });
  });

  it('needs an account behind the session', async () => {
    const token = await sessionToken('a'.repeat(24), uniqueEmail());
    expect(await createParty(token)).toMatchObject({ status: 401, body: { error: { message: 'You must be logged in before creating the party.' } } });
  });

  it('retries a code collision, gives up after ten, and keeps a request on its new code', async () => {
    const host = await signIn();
    let calls = 0;
    const collideOnce = testEnv({ PARTY: { getByName: (slug: string) => (++calls === 1 ? { create: async () => ({ ok: false, conflict: true }) } : env.PARTY.getByName(slug)) } as any });
    const k = key();
    const first = await createParty(host.token, 'Collided', { key: k, env: collideOnce });
    expect([first.status, calls]).toEqual([201, 2]);
    expect((await createParty(host.token, 'Collided', { key: k })).body.code).toBe(first.body.code);

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const alwaysCollide = testEnv({ PARTY: { getByName: () => ({ create: async () => ({ ok: false, conflict: true }) }) } as any });
    expect(await createParty(host.token, 'Never', { env: alwaysCollide })).toMatchObject({ status: 500, body: { error: { code: 'internal', errorId: expect.any(String) } } });
    error.mockRestore();
  });

  it('answers a repeated request with its party, never picks a new code for a repeat, and refuses one whose party is gone', async () => {
    const host = await signIn();
    const k = key();
    const first = await createParty(host.token, 'Once', { key: k });
    const [a, b] = await Promise.all([createParty(host.token, 'Once', { key: k }), createParty(host.token, 'Once', { key: k })]);
    expect([a.body.code, b.body.code]).toEqual([first.body.code, first.body.code]);

    let calls = 0;
    const collide = testEnv({ PARTY: { getByName: () => (++calls, { create: async () => ({ ok: false, conflict: true }) }) } as any });
    expect(await createParty(host.token, 'Once', { key: k, env: collide })).toMatchObject({ status: 409 });
    expect(calls).toBe(1);

    await request('POST', '/v1/parties/delete', { body: { code: first.body.code }, token: host.token });
    expect(await createParty(host.token, 'Once', { key: k })).toMatchObject({
      status: 409, body: { error: { message: 'This party is no longer available. Please start a new one.' } },
    });
  });

  it('forgets a request after ten minutes', async () => {
    const host = await signIn();
    const k = key();
    const first = await createParty(host.token, 'Old', { key: k });
    await runInDurableObject(env.USER.getByName(host.email), async (_i, state) => {
      state.storage.sql.exec('UPDATE create_requests SET expires_at = 0');
    });
    expect((await createParty(host.token, 'Old', { key: k })).body.code).not.toBe(first.body.code);
  });
});

describe('POST /v1/parties/join?code=', () => {
  it('joins with the phrase and the name from the form, filling an empty profile name only', async () => {
    const host = await signIn(uniqueEmail(), 'Host');
    const { body: party } = await createParty(host.token, 'P', { password: 'pw' });
    const named = await signIn(uniqueEmail(), 'Old name');
    expect(await join(named.token, party.code, 'G')).toMatchObject({ status: 403, body: { error: { field: 'password' } } });
    expect(await join(named.token, party.code, 'Form name', 'PW')).toMatchObject({ status: 200, body: { isJoined: true, participants: ['Host'] } });
    expect((await env.USER.getByName(named.email).get())!.name).toBe('Old name');
    const newcomer = await signIn();
    await join(newcomer.token, party.code, 'First join', 'pw');
    expect((await env.USER.getByName(newcomer.email).get())!.name).toBe('First join');
  });

  it('answers 429 over the join limit, and 401 for a deleted account without storing anything', async () => {
    const host = await signIn();
    const { body: party } = await createParty(host.token);
    const guest = await signIn();
    expect(await request('POST', '/v1/parties/join', { token: guest.token, body: { code: party.code, name: 'G' }, env: testEnv({ JOIN_RATE_LIMIT_USER: denied }) }))
      .toMatchObject({ status: 429, body: { error: { field: 'party' } } });
    await env.USER.getByName(guest.email).tombstone();
    expect(await join(guest.token, party.code)).toMatchObject({ status: 401, body: { error: { message: 'You must be logged in before joining the party.' } } });
    expect((await request('GET', `/v1/parties?code=${party.code}`, { token: host.token })).body.participantCount).toBe(1);
  });
});

describe('leave, draw, delete and restore', () => {
  const act = (code: string, action: string, token: string) => request('POST', `/v1/parties/${action}`, { token, body: { code } });

  it('need a session that still holds', async () => {
    const host = await signIn();
    const { body: party } = await createParty(host.token);
    const stale = await sessionToken(host.id, host.email, 7);
    for (const action of ['leave', 'draw', 'delete', 'restore']) {
      expect((await act(party.code, action, stale)).status).toBe(401);
    }
    await act(party.code, 'delete', host.token);
    expect(await act(party.code, 'restore', stale)).toMatchObject({ status: 401, body: { error: { message: 'You must be logged in before restoring the party.' } } });
  });

  it('restore an open party only with a free slot, and a closed one without needing one', async () => {
    const host = await signIn();
    const guest = await signIn();
    const parties = [];
    for (let i = 0; i < 3; i++) {
      parties.push((await createParty(host.token, `P${i}`)).body);
    }
    await act(parties[0].code, 'delete', host.token);
    await createParty(host.token, 'Replacement');
    expect(await act(parties[0].code, 'restore', host.token)).toMatchObject({
      status: 409, body: { error: { message: 'You can host up to 3 open parties at a time. Close or delete one of them to restore this one.' } },
    });

    await join(guest.token, parties[1].code);
    expect((await act(parties[1].code, 'draw', host.token)).status).toBe(200);
    await runInDurableObject(env.PARTY.getByName(parties[1].code), async (instance: PartyDO) => {
      (instance as any).setDeleted(Date.now());
    });
    expect(await act(parties[1].code, 'restore', host.token)).toMatchObject({ status: 200, body: { isClosed: true, deletedAt: null } });
  });
});

describe('schemas', () => {
  const issue = (schema: v.GenericSchema, value: unknown) => {
    const result = v.safeParse(schema, value, { abortEarly: true });
    return result.success ? 'ok' : { message: result.issues[0].message, field: v.getDotPath(result.issues[0]) };
  };

  it('clean request bodies: trimmed, spaces collapsed, emails lowercased, codes uppercased, phrases only trimmed, null as absent', () => {
    expect(v.parse(bodies.createParty, { name: '  Office \n  party  !  ', password: '  Jingle   Bells ' })).toEqual({ name: 'Office party!', password: 'Jingle   Bells' });
    expect(v.parse(bodies.createParty, { name: 'x', password: null })).toEqual({ name: 'x', password: undefined });
    expect(v.parse(bodies.magicLink, { email: ' Someone@Example.COM ', party: 'qwertyui' })).toEqual({ email: 'someone@example.com', typed: 'someone@example.com', party: 'QWERTYUI' });
    expect(v.parse(bodies.empty, {})).toEqual({});
  });

  it('refuse missing, non-text, unknown and over-long fields, naming the field', () => {
    expect(issue(bodies.profile, {})).toEqual({ message: 'Name is required.', field: 'name' });
    expect(issue(bodies.profile, { name: null })).toEqual({ message: 'Name is required.', field: 'name' });
    expect(issue(bodies.profile, { name: true })).toEqual({ message: 'Must be text.', field: 'name' });
    expect(issue(bodies.profile, { name: 'x'.repeat(101) })).toEqual({ message: 'Name must be at most 100 characters.', field: 'name' });
    expect(issue(bodies.empty, { [`${'k'.repeat(80)}`]: 'v' })).toEqual({ message: `Unknown field: ${'k'.repeat(50)}.`, field: 'k'.repeat(80) });
    expect(issue(bodies.magicLink, { email: 'nope' })).toEqual({ message: 'Must be a valid email', field: 'email' });
    expect(issue(bodies.magicLink, { email: 'a@example.com', party: 'abc' })).toEqual({ message: 'Invalid party code', field: 'party' });
    expect(issue(bodies.session, { token: 'x'.repeat(2049) })).toMatchObject({ field: 'token' });
    expect(issue(bodies.joinParty, { code: 'QWERTYUI', name: 'x', password: 'p'.repeat(101) })).toMatchObject({ field: 'password' });
    expect(issue(bodies.joinParty, { name: 'x' })).toEqual({ message: 'Invalid party code', field: 'code' });
    expect(issue(bodies.partyAction, { code: 'qwertyui', extra: 1 })).toMatchObject({ field: 'extra' });
    expect(v.parse(bodies.partyAction, { code: ' qwertyui ' })).toEqual({ code: 'QWERTYUI' });
  });

  it('read page sizes and cursors from the query string', () => {
    expect(v.parse(queries.partyHistory, {})).toEqual({ first: 10 });
    expect(v.parse(queries.partyHistory, { first: '100', other: 'ignored' })).toEqual({ first: 100 });
    for (const first of ['0', '101', '-1', 'abc', '1000']) {
      expect(issue(queries.partyHistory, { first })).toEqual({ message: 'Must be a whole number from 1 to 100.', field: 'first' });
    }
    const cursor = encodeCursor({ createdAt: 1700000000000, slug: 'QWERT' });
    expect(v.parse(queries.partyHistory, { after: cursor })).toEqual({ first: 10, after: { createdAt: 1700000000000, slug: 'QWERT' } });
    for (const after of ['', 'x'.repeat(101), '%%%', btoa('nope'), btoa('12:lower'), btoa(`${'9'.repeat(16)}:QWERT`)]) {
      expect(issue(queries.partyHistory, { after })).toEqual({ message: 'Invalid cursor.', field: 'after' });
    }
  });

  it('read party codes, keys and bearer tokens', () => {
    expect(v.parse(partyQuery, { code: 'qwertyui' })).toEqual({ code: 'QWERTYUI' });
    expect(issue(partyQuery, { code: 'nope!' })).not.toBe('ok');
    expect(v.parse(headers.idempotency, { 'idempotency-key': undefined })).toEqual({});
    expect(issue(headers.idempotency, { 'idempotency-key': 'short' })).toMatchObject({ field: 'idempotency-key' });
    expect(v.parse(headers.bearer, 'Bearer a.b.c')).toBe('a.b.c');
    for (const header of ['Basic a.b.c', 'Bearer abc', `Bearer ${'a'.repeat(2050)}.b.c`]) {
      expect(issue(headers.bearer, header)).not.toBe('ok');
    }
  });

  it('read token payloads, refusing ones without what identifies the user or the link', () => {
    const sub = nodeIdToStr({ kind: 'User', id: 'a'.repeat(24) });
    expect(v.parse(tokens.user, { sub, email: 'a@example.com', ver: 2, iat: 1 })).toEqual({ sub: 'a'.repeat(24), email: 'a@example.com', ver: 2 });
    for (const payload of [{ sub: nodeIdToStr({ kind: 'Party', id: 'QWERT' }), email: 'a' }, { sub: '%%%', email: 'a' }, { sub }, { sub, email: 'a', ver: '1' }]) {
      expect(issue(tokens.user, payload)).not.toBe('ok');
    }
    expect(v.parse(tokens.enterRequest, { email: 'A@Example.com', jti: 'j', exp: 5 })).toEqual({ email: 'a@example.com', jti: 'j', exp: 5 });
    expect(issue(tokens.emailChange, { sub, email: 'a', jti: 'j', exp: 5 })).toMatchObject({ field: 'newEmail' });
  });

  it('shape responses from stored records, leaving out anything that is not part of the answer', () => {
    const view = {
      id: 'x', slug: 'QWERT', name: 'P', password: null, isProtected: false, isHost: false, isJoined: true,
      isClosed: true, createdAt: Date.UTC(2026, 11, 1, 18, 30), closedAt: Date.UTC(2026, 11, 20, 9, 0, 5, 250),
      deletedAt: null, participantCount: 2, participants: ['A'], target: { id: 'a'.repeat(24), name: 'A' },
    };
    expect(v.parse(partyJson, view)).toEqual({
      code: 'QWERT', name: 'P', password: null, isProtected: false, isHost: false, isJoined: true, isClosed: true,
      createdAt: '2026-12-01T18:30:00.000Z', rolledAt: '2026-12-20T09:00:05.250Z', deletedAt: null, restorableUntil: null,
      participantCount: 2, participants: ['A'], target: { name: 'A' },
    });
    expect(v.parse(partyJson, { ...view, target: null, closedAt: null, deletedAt: Date.UTC(2026, 11, 2) })).toMatchObject({
      target: null, rolledAt: null, deletedAt: '2026-12-02T00:00:00.000Z', restorableUntil: '2026-12-03T00:00:00.000Z',
    });
    expect(v.parse(userJson, { id: 'a'.repeat(24), email: 'a@example.com', name: 'A', joined: 1, tokenVersion: 3 }))
      .toEqual({ id: nodeIdToStr({ kind: 'User', id: 'a'.repeat(24) }), name: 'A', email: 'a@example.com' });
    expect(v.parse(partyPage, {
      items: [{ slug: 'QWERT', name: 'P', createdAt: 0, isHost: true, isProtected: false, isClosed: false, closedAt: null }],
      hasMore: false, endCursor: null,
    })).toEqual({
      items: [{ code: 'QWERT', name: 'P', isHost: true, isProtected: false, isClosed: false, isJoined: true, createdAt: '1970-01-01T00:00:00.000Z', rolledAt: null, deletedAt: null, restorableUntil: null }],
      hasMore: false, endCursor: null,
    });
    // A record that doesn't fit is a bug, not something to answer with.
    expect(() => v.parse(partyJson, { ...view, name: 7 })).toThrow();
  });

  it('report a problem with the input as a whole without a field', async () => {
    const request = { req: { text: async () => '{}' } } as unknown as Parameters<typeof readBody>[0];
    await expect(readBody(request, v.string('Expected text.'))).rejects.toMatchObject({ code: 'invalid', message: 'Expected text.', field: undefined });
  });

  it('build error bodies with and without a field, and hash keys', async () => {
    expect(fail('invalid', 'x').toBody()).toEqual({ error: { code: 'invalid', message: 'x' } });
    expect(fail('conflict', 'y', 'f').status).toBe(409);
    expect(await keyHash(undefined)).toBeUndefined();
    expect(await keyHash('k')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sessions', () => {
  it('read the bearer token, refusing anything that is not a well-formed user token', async () => {
    const email = uniqueEmail();
    const stored = await env.USER.getByName(email).ensure(email);
    const sub = nodeIdToStr({ kind: 'User', id: stored.id });
    expect(await authenticate(env, `Bearer ${await sessionToken(stored.id, email, 3)}`)).toMatchObject({ userId: stored.id, email, tokenVersion: 3 });
    expect(await authenticate(env, `Bearer ${await sessionToken(stored.id, email)}`)).toMatchObject({ tokenVersion: undefined });
    const refused = [
      undefined, '', 'Bearer', 'Bearer garbage', 'Basic a.b.c', `Bearer ${'a'.repeat(2050)}.b.c`,
      `Bearer ${await jwt().issueToken('UserToken', { sub: nodeIdToStr({ kind: 'Party', id: 'QWERT' }), email }, { ttl: 60 })}`,
      `Bearer ${await jwt().issueToken('UserToken', { sub }, { ttl: 60 })}`,
      `Bearer ${await jwt().issueToken('UserToken', { sub, email, ver: '1' }, { ttl: 60 })}`,
      `Bearer ${await jwt().issueToken('UserToken', { sub: 'not-base64!', email }, { ttl: 60 })}`,
      `Bearer ${await jwt().issueToken('EnterRequest', { email }, { ttl: 60 })}`,
    ];
    for (const header of refused) {
      expect(await authenticate(env, header)).toBeUndefined();
    }
  });

  it('check the token against the user once per request', async () => {
    const email = uniqueEmail();
    const stored = await env.USER.getByName(email).ensure(email);
    const get = vi.fn(() => env.USER.getByName(email).get());
    const counting = { ...env, USER: { getByName: () => ({ get }) } } as unknown as typeof env;
    const session = makeSession(counting, stored.id, email, 0);
    expect(await session.verify()).toMatchObject({ id: stored.id });
    await session.verify();
    expect(get).toHaveBeenCalledTimes(1);
    expect(await makeSession(env, stored.id, email, 5).verify()).toBeNull();
  });
});

describe('PartyDO joins that must check the session on their own', () => {
  /** Queues an update for the member, so the party can't update them in the same call as the join. */
  const queueFor = (code: string, email: string) => runInDurableObject(env.PARTY.getByName(code), async (_i, state) => {
    state.storage.sql.exec('INSERT INTO outbox (payload, next_attempt_at) VALUES (?, ?)', JSON.stringify({ kind: 'user.sync', email }), Date.now() + 60_000);
  });

  it('check the session first, then join through the outbox', async () => {
    const host = await signIn();
    const { body: party } = await createParty(host.token);
    const guest = await signIn();
    await queueFor(party.code, guest.email);
    expect(await join(guest.token, party.code)).toMatchObject({ status: 200, body: { isJoined: true } });

    const ghost = await signIn();
    await queueFor(party.code, ghost.email);
    await env.USER.getByName(ghost.email).tombstone();
    expect((await join(ghost.token, party.code)).status).toBe(401);
  });

  it('refuse when the user can\'t be reached, rather than joining unchecked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const host = await signIn();
    const { body: party } = await createParty(host.token);
    const guest = await signIn();
    const unreachable = { getByName: () => ({ apply: async () => { throw new Error('down'); }, get: async () => { throw new Error('down'); } }) };
    for (const queued of [false, true]) {
      if (queued) {
        await queueFor(party.code, guest.email);
      }
      const result = await runInDurableObject(env.PARTY.getByName(party.code), async (instance: PartyDO) => {
        const original = (instance as any).env;
        (instance as any).env = { ...original, USER: unreachable };
        try {
          return await instance.join({ id: guest.id, email: guest.email, name: '' }, 'Guest', null, { tokenVersion: 0 });
        } finally {
          (instance as any).env = original;
        }
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    }
    expect((await request('GET', `/v1/parties?code=${party.code}`, { token: host.token })).body.participantCount).toBe(1);
    warn.mockRestore();
  });

  it('look again after the check: the party may be gone, closed, full, or already joined by then', async () => {
    const host = await signIn();
    const other = await signIn();
    const guest = await signIn();
    const outcomes = [];
    for (const change of ['deleted', 'closed', 'filled', 'joined'] as const) {
      const { body: party } = await createParty((change === 'deleted' ? host : other).token, `Race ${change}`);
      if (change === 'closed') {
        const filler = await signIn();
        await join(filler.token, party.code);
      }
      await queueFor(party.code, guest.email);
      outcomes.push(await runInDurableObject(env.PARTY.getByName(party.code), async (instance: PartyDO, state) => {
        const original = (instance as any).env;
        (instance as any).env = {
          ...original,
          USER: {
            getByName: (email: string) => ({
              get: async () => {
                if (change === 'deleted') state.storage.sql.exec('UPDATE party SET deleted_at = ?', Date.now());
                if (change === 'closed') state.storage.sql.exec('UPDATE party SET is_closed = 1');
                if (change === 'filled') {
                  for (let i = 1; i < MAX_PARTY_MEMBERS; i++) {
                    state.storage.sql.exec('INSERT INTO memberships (member_id, name, joined_at) VALUES (?, ?, 1)', `stand-in-${i}`, `Stand-in ${i}`);
                  }
                }
                if (change === 'joined') state.storage.sql.exec("INSERT INTO memberships (member_id, member_email, name, joined_at) VALUES (?, ?, 'Guest', 1)", guest.id, guest.email);
                return await env.USER.getByName(email).get();
              },
            }),
          },
        };
        try {
          return await instance.join({ id: guest.id, email: guest.email, name: '' }, 'Guest', null, { tokenVersion: 0 });
        } finally {
          (instance as any).env = original;
        }
      }));
    }
    expect(outcomes.map(o => (o.ok ? 'ok' : o.error.code))).toEqual(['not_found', 'conflict', 'conflict', 'ok']);
    expect(outcomes[2]).toMatchObject({ ok: false, error: { message: `This party is full: it already has ${MAX_PARTY_MEMBERS} people.` } });
  });
});

describe('PartyDO repeats', () => {
  it('draw once, delete once, restore once, and give back a slot held for a restore that raced another', async () => {
    const host = await signIn();
    const guest = await signIn();
    const stub = (code: string) => env.PARTY.getByName(code);
    const { body: party } = await createParty(host.token);
    await join(guest.token, party.code);
    const drawn = await stub(party.code).close(host.id);
    expect(await stub(party.code).close(host.id)).toEqual(drawn);

    const { body: open } = await createParty(host.token, 'Open');
    const deleted = await stub(open.code).delete(host.id);
    expect(await stub(open.code).delete(host.id)).toEqual(deleted);
    expect(await stub(open.code).delete(guest.id)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    await runInDurableObject(stub(open.code), async (_i, state) => {
      state.storage.sql.exec('UPDATE party SET deleted_at = ?', Date.now() - DAY - 1000);
    });
    expect(await stub(open.code).delete(host.id)).toMatchObject({ ok: false, error: { code: 'not_found' } });

    const { body: other } = await createParty(host.token, 'Other');
    const hosting = await env.USER.getByName(host.email).startHosting(3, { userId: host.id, tokenVersion: 0 });
    expect(hosting).toMatchObject({ allowed: true, reservation: expect.any(String) });
    expect(await stub(other.code).restore(host.id, (hosting as any).reservation)).toMatchObject({ ok: true, view: { deletedAt: null } });
    await runDurableObjectAlarm(stub(other.code));
    expect(await runInDurableObject(env.USER.getByName(host.email), async (_i, state) =>
      state.storage.sql.exec('SELECT COUNT(*) AS n FROM host_reservations').one().n)).toBe(0);
    // A host with no email (an imported row) holds no slot to give back.
    await runInDurableObject(stub(other.code), async (_i, state) => {
      state.storage.sql.exec('UPDATE memberships SET member_email = NULL');
    });
    expect(await stub(other.code).restore(host.id, 'held')).toMatchObject({ ok: true });
  });
});

describe('UserDO request ids and sessions', () => {
  it('starts a mail request only for the session it belongs to, claiming its id once', async () => {
    const who = await signIn();
    const stub = env.USER.getByName(who.email);
    const session = { userId: who.id, tokenVersion: 0 };
    expect(await stub.beginMailRequest({ userId: who.id, tokenVersion: 1 }, 'k', '', { limit: 6 })).toBeNull();
    expect(await stub.beginMailRequest(session, undefined, '', { limit: 6 })).toMatchObject({ id: who.id });
    expect(await stub.beginMailRequest(session, 'k', '', { limit: 6 })).toMatchObject({ id: who.id });
    expect(await stub.beginMailRequest(session, 'k', '', { limit: 6 })).toBe('repeat');
    expect(await stub.seenMailRequest('k', '')).toBe(true);
    expect(await stub.seenMailRequest('k', 'other')).toBe(false);
  });

  it('lists parties only for the session they belong to', async () => {
    const who = await signIn();
    const stub = env.USER.getByName(who.email);
    expect(await stub.listParties(10, null, { userId: who.id, tokenVersion: 0 })).toEqual([]);
    expect(await stub.listParties(10, null, { userId: 'someone-else', tokenVersion: 0 })).toBeNull();
  });
});

describe('the remaining refusals', () => {
  it('refuse malformed bodies, keys and cursors, and fall back to "unknown" without a client IP', async () => {
    for (const raw of ['[]', '"x"', 'null', '7']) {
      expect(await request('POST', '/v1/auth/magic-link', { raw })).toMatchObject({ status: 400, body: { error: { message: 'The request body must be a JSON object.' } } });
    }
    expect(await request('POST', '/v1/auth/magic-link', { key: 'bad key', body: { email: uniqueEmail() } })).toMatchObject({ status: 400, body: { error: { field: 'Idempotency-Key' } } });
    const res = await (await import('src/index')).app.request('/v1/parties?code=QWERT', {}, testEnv());
    expect(res.status).toBe(404);
  });

  it('refuse deleting or restoring a party that isn\'t yours, doesn\'t exist, is rolled, or is past its restore window', async () => {
    const host = await signIn();
    const guest = await signIn();
    const stub = (code: string) => env.PARTY.getByName(code);
    expect(await stub('ZZZZY').delete(host.id)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    const { body: party } = await createParty(host.token);
    await join(guest.token, party.code);
    expect(await stub(party.code).delete(guest.id)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await stub(party.code).restore(guest.id)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    await stub(party.code).close(host.id);
    expect(await stub(party.code).delete(host.id)).toMatchObject({ ok: false, error: { code: 'conflict' } });

    const { body: other } = await createParty(host.token, 'Other');
    await stub(other.code).delete(host.id);
    // Let the delete's own alarm run first; it then waits for the end of the restore window.
    await runDurableObjectAlarm(stub(other.code));
    // Past the window, with no alarm left: one firing before the restore would erase the party (then "not found").
    await runInDurableObject(stub(other.code), async (_i, state) => {
      state.storage.sql.exec('UPDATE party SET deleted_at = ?', Date.now() - DAY - 1000);
      await state.storage.deleteAlarm();
    });
    expect(await stub(other.code).restore(host.id)).toMatchObject({ ok: false, error: { code: 'conflict', message: 'This party was deleted more than a day ago and can no longer be restored.' } });
  });

  it('refuse a confirmation link that was used by another request, or while the account is busy', async () => {
    const who = await signIn();
    const token = await jwt().issueToken('EmailChange', { sub: who.nodeId, email: who.email, newEmail: uniqueEmail(), jti: crypto.randomUUID(), ver: 0 }, { ttl: 60 });
    await env.USER.getByName(who.email).startAccountChange(who.id, 'other', Date.now() + 60_000);
    expect(await request('POST', '/v1/me/email-change/confirm', { body: { token } })).toMatchObject({ status: 409, body: { error: { code: 'account_busy' } } });
  });

  it('treat a create request stored before details were kept, or made without one, as its own request', async () => {
    const host = await signIn();
    const k = key();
    const first = await createParty(host.token, 'Old row', { key: k });
    await runInDurableObject(env.USER.getByName(host.email), async (_i, state) => {
      state.storage.sql.exec('UPDATE create_requests SET detail = NULL');
    });
    expect((await createParty(host.token, 'Old row', { key: k })).body.code).not.toBe(first.body.code);

    const session = { userId: host.id, tokenVersion: 0 };
    const stub = env.USER.getByName(host.email);
    const without = await stub.startHosting(3, session, { key: 'no-detail', id: 'p1', slug: 'QWERTYUI' });
    expect(without).toMatchObject({ allowed: true, request: { id: 'p1' } });
    expect(await stub.startHosting(3, session, { key: 'no-detail', id: 'p2', slug: 'ASDFGHJK' })).toMatchObject({ request: { id: 'p1' } });
  });
});

describe('PartyDO with older data', () => {
  it('deletes and restores a party stored before deletion existed, skipping a member imported without an email', async () => {
    const host = await signIn();
    // A party stored with the old schema, in an object that has not looked at its tables yet.
    await runInDurableObject(env.PARTY.getByName('OLDPA'), async (_i, state) => {
      state.storage.sql.exec(`
        CREATE TABLE party (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, password TEXT, host_id TEXT NOT NULL, is_closed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
        CREATE TABLE memberships (member_id TEXT PRIMARY KEY, member_email TEXT, name TEXT NOT NULL, target_id TEXT, target_name TEXT, joined_at INTEGER NOT NULL);
        CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL);
      `);
      state.storage.sql.exec("INSERT INTO party VALUES ('p', 'OLDPA', 'Old schema', NULL, ?, 0, 1)", host.id);
      state.storage.sql.exec("INSERT INTO memberships VALUES (?, ?, 'Host', NULL, NULL, 1), ('m', NULL, 'No email', NULL, NULL, 2)", host.id, host.email);
    });
    expect(await request('POST', '/v1/parties/delete', { body: { code: 'OLDPA' }, token: host.token })).toMatchObject({ status: 200, body: { code: 'OLDPA', deletedAt: expect.any(String) } });
    expect((await request('POST', '/v1/parties/restore', { body: { code: 'OLDPA' }, token: host.token })).status).toBe(200);
  });

  it('erases a deleted party for good after a day, even one whose host had left or that predates tombstones', async () => {
    const host = await signIn();
    const { body: party } = await createParty(host.token, 'Old one');
    await request('POST', '/v1/parties/delete', { body: { code: party.code }, token: host.token });
    await runDurableObjectAlarm(env.PARTY.getByName(party.code));
    await runInDurableObject(env.PARTY.getByName(party.code), async (instance: PartyDO, state) => {
      state.storage.sql.exec('UPDATE party SET deleted_at = ?', Date.now() - DAY - 1000);
      state.storage.sql.exec('DROP TABLE cancelled');
      state.storage.sql.exec('DELETE FROM memberships');
      await instance.alarm();
      expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM party').one().n).toBe(0);
    });
  });

  it('moves a deleted party to a new email without putting it back in a guest\'s list', async () => {
    const host = await signIn();
    const guest = await signIn();
    const { body: party } = await createParty(host.token, 'Moving');
    await join(guest.token, party.code);
    await request('POST', '/v1/parties/delete', { body: { code: party.code }, token: host.token });
    const stub = env.PARTY.getByName(party.code);
    expect(await stub.changeMemberEmail(guest.id, guest.email, 'moved-guest@example.com')).toBeNull();
    expect(await stub.changeMemberEmail(host.id, host.email, 'moved-host@example.com')).toMatchObject({ slug: party.code, deletedAt: expect.any(Number) });
  });
});

