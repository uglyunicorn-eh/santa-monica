import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { MAX_BODY_BYTES, MAX_NAME_LENGTH } from 'src/api/limits';
import { PARTY_CODE_RE } from 'src/api/schemas';
import { MAX_PARTY_PHRASE_GUESSES, MAX_PHRASE_GUESSES, PHRASE_GUESS_WINDOW_MS } from 'src/do/PartyDO';

import { denied, request, signIn, testEnv, uniqueEmail } from './helpers';

const create = async (token: string, password?: string) =>
  (await request('POST', '/v1/parties', { token, body: { name: 'Limits', ...(password ? { password } : {}) } })).body;
const join = (token: string, code: string, password?: string, e = testEnv()) =>
  request('POST', '/v1/parties/join', { token, env: e, body: { code: code, name: 'Guest', ...(password ? { password } : {}) } });

describe('party codes', () => {
  it('gives new parties 8-letter codes and still accepts 5-letter ones', async () => {
    const host = await signIn();
    const { code } = await create(host.token);
    expect(code).toMatch(/^[A-Z]{8}$/);
    expect(PARTY_CODE_RE.test(code)).toBe(true);
    expect(PARTY_CODE_RE.test('QWERT')).toBe(true);
    for (const bad of ['QWER', 'QWERTY', 'QWERTYU', 'QWERTYUIP', 'qwertyui']) {
      expect(PARTY_CODE_RE.test(bad)).toBe(false);
    }
  });
});

describe('request size', () => {
  it('refuses a body over the limit, and takes one at the limit to validation', async () => {
    const over = await request('POST', '/v1/auth/magic-link', { raw: 'x'.repeat(MAX_BODY_BYTES + 1) });
    expect(over).toMatchObject({ status: 413, body: { error: { code: 'invalid', message: 'The request is too large.' } } });
    const at = await request('POST', '/v1/auth/magic-link', { raw: 'x'.repeat(MAX_BODY_BYTES) });
    expect(at).toMatchObject({ status: 400, body: { error: { message: 'The request body must be JSON.' } } });
  });

  it('bounds names at the shared limit', async () => {
    const who = await signIn();
    expect((await request('PATCH', '/v1/me', { token: who.token, body: { name: 'x'.repeat(MAX_NAME_LENGTH) } })).status).toBe(200);
    expect((await request('PATCH', '/v1/me', { token: who.token, body: { name: 'x'.repeat(MAX_NAME_LENGTH + 1) } })).status).toBe(400);
  });
});

describe('joining', () => {
  it('refuses joins once the user is over their rate limit', async () => {
    const host = await signIn();
    const { code } = await create(host.token);
    const guest = await signIn();
    expect(await join(guest.token, code, undefined, testEnv({ JOIN_RATE_LIMIT_USER: denied }))).toMatchObject({
      status: 429, body: { error: { field: 'party', message: "Whoa, that's a lot of tries! Please wait a minute and try again." } },
    });
  });

  describe('secret phrase guesses', () => {
    const wrong = { status: 403, body: { error: { code: 'forbidden', field: 'password', message: expect.stringMatching(/wrong secret phrase/) } } };
    const locked = (minutes: number) => ({
      status: 429,
      body: { error: { code: 'rate_limited', field: 'password', message: `That's a lot of wrong guesses! Please ask your friend for the secret phrase and try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` } },
    });
    /** Moves this person's first wrong guess back in time. */
    const firstGuessAgo = (code: string, memberId: string, ms: number) => runInDurableObject(env.PARTY.getByName(code), async (_i, state) => {
      state.storage.sql.exec('UPDATE phrase_guesses SET first_failed_at = ? WHERE member_id = ?', Date.now() - ms, memberId);
    });

    it(`allows ${MAX_PHRASE_GUESSES} wrong guesses, then makes the guesser wait, even with the right phrase`, async () => {
      const host = await signIn();
      const { code } = await create(host.token, 'mistletoe');
      const guest = await signIn();
      for (let i = 0; i < MAX_PHRASE_GUESSES; i++) {
        expect(await join(guest.token, code, `guess ${i}`)).toMatchObject(wrong);
      }
      expect(await join(guest.token, code, 'mistletoe')).toMatchObject(locked(15));

      // Another person is not affected.
      expect((await join((await signIn()).token, code, 'mistletoe')).status).toBe(200);
    });

    it('lets the guesser try again once the window has passed, and forgets their guesses when they get it right', async () => {
      const host = await signIn();
      const { code } = await create(host.token, 'mistletoe');
      const guest = await signIn(uniqueEmail());
      for (let i = 0; i < MAX_PHRASE_GUESSES; i++) {
        await join(guest.token, code, `guess ${i}`);
      }
      await firstGuessAgo(code, guest.id, PHRASE_GUESS_WINDOW_MS - 30_000);
      expect(await join(guest.token, code, 'mistletoe')).toMatchObject(locked(1));

      await firstGuessAgo(code, guest.id, PHRASE_GUESS_WINDOW_MS + 1000);
      expect((await join(guest.token, code, 'mistletoe')).status).toBe(200);
      expect(await runInDurableObject(env.PARTY.getByName(code), async (_i, state) =>
        state.storage.sql.exec('SELECT COUNT(*) AS n FROM phrase_guesses WHERE member_id = ?', guest.id).one().n)).toBe(0);
    });

    it('starts counting again after a quiet window', async () => {
      const host = await signIn();
      const { code } = await create(host.token, 'mistletoe');
      const guest = await signIn();
      for (let i = 0; i < MAX_PHRASE_GUESSES - 1; i++) {
        await join(guest.token, code, `guess ${i}`);
      }
      await firstGuessAgo(code, guest.id, PHRASE_GUESS_WINDOW_MS + 1000);
      // The window passed, so this wrong guess is the first of a new one, not the fifth.
      expect(await join(guest.token, code, 'nope')).toMatchObject(wrong);
      expect(await join(guest.token, code, 'nope again')).toMatchObject(wrong);
      expect(await runInDurableObject(env.PARTY.getByName(code), async (_i, state) =>
        state.storage.sql.exec('SELECT failures FROM phrase_guesses WHERE member_id = ?', guest.id).one().failures)).toBe(2);
    });
  });
});

describe('guessing a party\'s secret phrase from many accounts', () => {
  const wrongGuess = async (code: string) => join((await signIn()).token, code, 'nope');

  it(`allows ${MAX_PARTY_PHRASE_GUESSES} wrong guesses from everyone together, then refuses more, while the right phrase still works`, async () => {
    const host = await signIn();
    const { code } = await create(host.token, 'mistletoe');
    for (let i = 0; i < MAX_PARTY_PHRASE_GUESSES; i++) {
      expect((await wrongGuess(code)).status).toBe(403);
    }
    expect(await wrongGuess(code)).toMatchObject({ status: 429, body: { error: { code: 'rate_limited', field: 'password', message: expect.stringMatching(/try again in 15 minutes/) } } });
    expect((await join((await signIn()).token, code, 'MISTLETOE')).status).toBe(200);
    // Refused guesses aren't counted.
    expect(await runInDurableObject(env.PARTY.getByName(code), async (_i, state) =>
      state.storage.sql.exec("SELECT failures FROM phrase_guesses WHERE member_id = ''").one().failures)).toBe(MAX_PARTY_PHRASE_GUESSES);
  });

  it('lets guessing go on once the window has passed', async () => {
    const host = await signIn();
    const { code } = await create(host.token, 'mistletoe');
    for (let i = 0; i < MAX_PARTY_PHRASE_GUESSES; i++) {
      await wrongGuess(code);
    }
    await runInDurableObject(env.PARTY.getByName(code), async (_i, state) => {
      state.storage.sql.exec("UPDATE phrase_guesses SET first_failed_at = ? WHERE member_id = ''", Date.now() - PHRASE_GUESS_WINDOW_MS - 1000);
    });
    expect((await wrongGuess(code)).status).toBe(403);
  });
});

describe('old 5-letter party codes', () => {
  const legacy = testEnv({ LEGACY_CODE_LOOKUP_RATE_LIMIT_IP: denied });

  it('are looked up, joined and put in sign-in links under the stricter limit; 8-letter codes are not', async () => {
    const host = await signIn();
    const { code } = await create(host.token);
    const guest = await signIn();
    expect(await request('GET', '/v1/parties?code=QWERT', { env: legacy })).toMatchObject({ status: 429, body: { error: { code: 'rate_limited' } } });
    expect(await join(guest.token, 'QWERT', undefined, legacy)).toMatchObject({ status: 429, body: { error: { field: 'party' } } });
    expect(await request('POST', '/v1/auth/magic-link', { body: { email: uniqueEmail(), party: 'QWERT' }, env: legacy })).toMatchObject({ status: 429, body: { error: { field: 'party' } } });
    expect((await request('GET', `/v1/parties?code=${code}`, { env: legacy })).status).toBe(200);
    expect((await join(guest.token, code, undefined, legacy)).status).toBe(200);
  });
});
