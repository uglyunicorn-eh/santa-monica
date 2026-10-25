import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { EMAILS_PER_ADDRESS_PER_HOUR } from 'src/api/rateLimit';
import { isPermanentMailError, recipientAllowed } from 'src/mail';
import { MAIL_QUOTA_WINDOW_MS } from 'src/do/UserDO';

import { denied, mailer, request, signIn, testEnv, uniqueEmail } from './helpers';

const key = () => crypto.randomUUID();

/** How many emails the address has had counted in the current window. */
const counted = (email: string) => runInDurableObject(env.USER.getByName(email), async (_i, state) =>
  state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM mail_sent').one().n);

/** Moves the address's counted emails out of the window, as if an hour had passed. */
const anHourLater = (email: string) => runInDurableObject(env.USER.getByName(email), async (_i, state) => {
  state.storage.sql.exec('UPDATE mail_sent SET at = at - ?', MAIL_QUOTA_WINDOW_MS);
});

const capped = { status: 429, body: { error: { code: 'rate_limited', message: "That's a lot of emails for this address. Please try again in an hour." } } };

describe('the per-address email cap', () => {
  const magicLink = (email: string, options: { key?: string; e?: typeof env } = {}) =>
    request('POST', '/v1/auth/magic-link', { body: { email }, key: options.key, env: options.e });

  it(`allows ${EMAILS_PER_ADDRESS_PER_HOUR} sign-in links an hour to one address, then refuses more until the hour has passed`, async () => {
    const email = uniqueEmail();
    const { sent, EMAIL } = mailer();
    for (let i = 0; i < EMAILS_PER_ADDRESS_PER_HOUR; i++) {
      expect((await magicLink(email, { e: testEnv({ EMAIL }), key: i % 2 ? key() : undefined })).status).toBe(202);
    }
    expect(await magicLink(email, { e: testEnv({ EMAIL }) })).toMatchObject({ ...capped, body: { error: { ...capped.body.error, field: 'email' } } });
    expect(await magicLink(email, { e: testEnv({ EMAIL }), key: key() })).toMatchObject(capped);
    expect(sent).toHaveLength(EMAILS_PER_ADDRESS_PER_HOUR);
    // Another address isn't affected.
    expect((await magicLink(uniqueEmail())).status).toBe(202);

    await anHourLater(email);
    expect((await magicLink(email, { e: testEnv({ EMAIL }) })).status).toBe(202);
    expect(sent).toHaveLength(EMAILS_PER_ADDRESS_PER_HOUR + 1);
  });

  it('counts a repeated request once, and keeps no claim for a refused one', async () => {
    const email = uniqueEmail();
    const k = key();
    for (let i = 0; i < 3; i++) {
      expect((await magicLink(email, { key: k })).status).toBe(202);
    }
    expect(await counted(email)).toBe(1);
    for (let i = 1; i < EMAILS_PER_ADDRESS_PER_HOUR; i++) {
      await magicLink(email);
    }
    const refused = key();
    expect(await magicLink(email, { key: refused })).toMatchObject(capped);
    expect(await env.USER.getByName(email).seenMailRequest(refused, '')).toBe(false);
  });

  it('gives the count back when the email could not be sent', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const email = uniqueEmail();
    expect((await magicLink(email, { key: key(), e: testEnv({ EMAIL: mailer(() => true).EMAIL }) })).status).toBe(503);
    expect(await counted(email)).toBe(0);
    error.mockRestore();
  });

  it('shares one count between sign-in links and account links', async () => {
    const who = await signIn();
    for (let i = 0; i < EMAILS_PER_ADDRESS_PER_HOUR - 1; i++) {
      await magicLink(who.email);
    }
    expect((await request('POST', '/v1/me/deletion', { token: who.token, key: key() })).status).toBe(202);
    expect(await request('POST', '/v1/me/deletion', { token: who.token, key: key() })).toMatchObject(capped);
    expect(await request('POST', '/v1/me/deletion', { token: who.token })).toMatchObject(capped);
    expect(await magicLink(who.email)).toMatchObject(capped);
  });

  it('caps email-change links to the new address, but never blocks the change over notices to the current one', async () => {
    const who = await signIn();
    const ask = (email: string, k?: string) => request('POST', '/v1/me/email-change', { token: who.token, key: k, body: { email } });

    const busy = uniqueEmail('busy');
    for (let i = 0; i < EMAILS_PER_ADDRESS_PER_HOUR; i++) {
      await magicLink(busy);
    }
    expect(await ask(busy)).toMatchObject({ ...capped, body: { error: { ...capped.body.error, field: 'email' } } });

    // The current address has had its fill, yet the change still goes ahead, and its notice is counted.
    for (let i = 0; i < EMAILS_PER_ADDRESS_PER_HOUR; i++) {
      await magicLink(who.email);
    }
    const { sent, EMAIL } = mailer();
    const before = await counted(who.email);
    const fresh = uniqueEmail('fresh');
    expect((await request('POST', '/v1/me/email-change', { token: who.token, key: key(), body: { email: fresh }, env: testEnv({ EMAIL }) })).status).toBe(202);
    expect(sent.map(m => m.to)).toEqual([fresh, who.email]);
    expect([await counted(who.email), await counted(fresh)]).toEqual([before + 1, 1]);

    // A refused change gives back what it counted.
    const counts = await counted(who.email);
    const limited = await request('POST', '/v1/me/email-change', {
      token: who.token, key: key(), body: { email: uniqueEmail() }, env: testEnv({ ENTER_RATE_LIMIT_EMAIL: denied }),
    });
    expect(limited.status).toBe(429);
    expect(await counted(who.email)).toBe(counts);

    // An address with an account gets a notice instead of the link, counted the same way.
    const taken = await signIn();
    expect((await ask(taken.email, key())).status).toBe(202);
    expect(await counted(taken.email)).toBe(1);
  });
});

describe('the email allowlist (PR previews)', () => {
  it('matches whole addresses and @domains, in any case; no list means anyone', () => {
    const list = ' tester@Example.com , @Team.test ,';
    expect(recipientAllowed(undefined, 'anyone@example.org')).toBe(true);
    expect(['tester@example.com', 'TESTER@example.com', 'a@team.test', 'b@TEAM.TEST'].map(to => recipientAllowed(list, to))).toEqual([true, true, true, true]);
    expect(['other@example.com', 'a@team.test.evil.example', 'a@notteam.test', 'tester@example.com.evil'].map(to => recipientAllowed(list, to))).toEqual([false, false, false, false]);
    expect(recipientAllowed('', 'tester@example.com')).toBe(false);
  });

  it("sends nothing to anyone else, and the outbox doesn't retry it", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { sent, EMAIL } = mailer();
    const preview = testEnv({ EMAIL, EMAIL_ALLOWLIST: '@allowed.test' });
    expect((await request('POST', '/v1/auth/magic-link', { body: { email: uniqueEmail() }, env: preview })).status).toBe(503);
    expect((await request('POST', '/v1/auth/magic-link', { body: { email: `ok-${crypto.randomUUID().slice(0, 8)}@allowed.test` }, env: preview })).status).toBe(202);
    expect(sent.map(m => m.to.split('@')[1])).toEqual(['allowed.test']);
    expect(isPermanentMailError(Object.assign(new Error('x'), { code: 'E_RECIPIENT_NOT_ALLOWED' }))).toBe(true);
    error.mockRestore();
  });
});
