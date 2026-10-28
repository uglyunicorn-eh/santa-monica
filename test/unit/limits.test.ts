import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { MAX_BODY_BYTES, MAX_PARTY_NAME_LENGTH, MAX_PERSON_NAME_LENGTH } from 'src/api/limits';
import { PARTY_CODE_RE } from 'src/api/schemas';
import { MAX_NEW_PARTIES_PER_DAY, MAX_OPEN_HOSTED_PARTIES } from 'src/api/routes/parties';
import { MAX_PARTY_MEMBERS, MAX_PARTY_PHRASE_GUESSES, MAX_PHRASE_GUESSES, PHRASE_GUESS_WINDOW_MS } from 'src/do/PartyDO';
import { PARTY_STARTS_WINDOW_MS } from 'src/do/UserDO';

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

  it(`bounds person names at ${MAX_PERSON_NAME_LENGTH} and party names at ${MAX_PARTY_NAME_LENGTH}`, async () => {
    const who = await signIn();
    const rename = (length: number) => request('PATCH', '/v1/me', { token: who.token, body: { name: 'x'.repeat(length) } });
    expect((await rename(MAX_PERSON_NAME_LENGTH)).status).toBe(200);
    expect(await rename(MAX_PERSON_NAME_LENGTH + 1)).toMatchObject({
      status: 400, body: { error: { field: 'name', message: `Name must be at most ${MAX_PERSON_NAME_LENGTH} characters.` } },
    });
    const create = (length: number) => request('POST', '/v1/parties', { token: who.token, body: { name: 'p'.repeat(length) } });
    expect((await create(MAX_PARTY_NAME_LENGTH)).status).toBe(201);
    expect(await create(MAX_PARTY_NAME_LENGTH + 1)).toMatchObject({ status: 400, body: { error: { field: 'name' } } });
    const party = (await create(MAX_PARTY_NAME_LENGTH)).body;
    const guest = await signIn();
    const join = (length: number) => request('POST', '/v1/parties/join', { token: guest.token, body: { code: party.code, name: 'g'.repeat(length) } });
    expect(await join(MAX_PERSON_NAME_LENGTH + 1)).toMatchObject({ status: 400, body: { error: { field: 'name' } } });
    expect((await join(MAX_PERSON_NAME_LENGTH)).status).toBe(200);
  });
});

describe('names', () => {
  it("can't hold a web address, since they go into emails; ordinary names with dots still can", async () => {
    const who = await signIn();
    const rename = (name: string) => request('PATCH', '/v1/me', { token: who.token, body: { name } });
    for (const name of ['evil.co', 'Win at www.example', 'https://x', 'bob@mail.com', 'Ask SANTA.CLAUS', 'St.Petersburg']) {
      expect([name, await rename(name)]).toMatchObject([name, { status: 400, body: { error: { field: 'name', message: "Name can't contain a web address." } } }]);
    }
    for (const name of ['J.R.R. Tolkien', 'Mr. Smith', 'Anne-Marie', 'Hi... there!', 'Zoë 2.0']) {
      expect([name, (await rename(name)).status]).toEqual([name, 200]);
    }
    expect(await request('POST', '/v1/parties', { token: who.token, body: { name: 'Gifts at evil.co' } })).toMatchObject({
      status: 400, body: { error: { field: 'name', message: "Party name can't contain a web address." } },
    });
    const party = (await request('POST', '/v1/parties', { token: who.token, body: { name: 'Office party' } })).body;
    const guest = await signIn();
    expect(await request('POST', '/v1/parties/join', { token: guest.token, body: { code: party.code, name: 'see evil.co' } })).toMatchObject({
      status: 400, body: { error: { field: 'name' } },
    });
  });
});

describe('party size', () => {
  /** Adds stand-in members straight to the party, so the test doesn't need a hundred real joins. */
  const addMembers = (code: string, count: number) => runInDurableObject(env.PARTY.getByName(code), async (_instance, state) => {
    for (let i = 0; i < count; i++) {
      state.storage.sql.exec('INSERT INTO memberships (member_id, name, joined_at) VALUES (?, ?, ?)', `stand-in-${i}`, `Stand-in ${i}`, Date.now());
    }
  });

  it(`takes at most ${MAX_PARTY_MEMBERS} people, host included`, async () => {
    const host = await signIn();
    const { code } = await create(host.token);
    await addMembers(code, MAX_PARTY_MEMBERS - 2);

    const last = await signIn();
    expect((await join(last.token, code)).status).toBe(200);
    expect(await join((await signIn()).token, code)).toMatchObject({
      status: 409, body: { error: { code: 'conflict', field: 'party', message: `This party is full: it already has ${MAX_PARTY_MEMBERS} people.` } },
    });
    // Someone already in still gets the party back when they join again.
    expect((await join(last.token, code)).status).toBe(200);
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
    expect(await request('POST', '/v1/parties/lookup', { body: { code: 'QWERT' }, env: legacy })).toMatchObject({ status: 429, body: { error: { code: 'rate_limited' } } });
    expect(await join(guest.token, 'QWERT', undefined, legacy)).toMatchObject({ status: 429, body: { error: { field: 'party' } } });
    expect(await request('POST', '/v1/auth/magic-link', { body: { email: uniqueEmail(), party: 'QWERT' }, env: legacy })).toMatchObject({ status: 429, body: { error: { field: 'party' } } });
    expect((await request('POST', '/v1/parties/lookup', { body: { code: code }, env: legacy })).status).toBe(200);
    expect((await join(guest.token, code, undefined, legacy)).status).toBe(200);
  });
});

describe('client addresses', () => {
  it('are counted per IPv6 /64, so rotating addresses inside one does not get around a limit', async () => {
    const keys: string[] = [];
    const counting = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) } as unknown as RateLimit;
    const e = testEnv({ PARTY_LOOKUP_RATE_LIMIT_IP: counting });
    for (const ip of ['2001:db8:1:2::a', '2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:3::a', '192.0.2.9']) {
      await request('POST', '/v1/parties/lookup', { body: { code: 'QWERTYUI' }, env: e, ip });
    }
    expect(keys).toEqual(['2001:db8:1:2::/64', '2001:db8:1:2::/64', '2001:db8:1:3::/64', '192.0.2.9']);
  });
});

describe('party codes in writes', () => {
  const write = (token: string, action: string, code: string, e: typeof env) =>
    request('POST', `/v1/parties/${action}`, { token, body: { code, ...(action === 'join' ? { name: 'Guest' } : {}) }, env: e });

  it('count against the per-client lookup limit on every route that takes one', async () => {
    const host = await signIn();
    const { code } = await create(host.token);
    const limited = testEnv({ PARTY_LOOKUP_RATE_LIMIT_IP: denied });
    for (const action of ['join', 'leave', 'draw', 'delete', 'restore']) {
      expect([action, await write(host.token, action, code, limited)]).toMatchObject([action, {
        status: 429, body: { error: { code: 'rate_limited', field: 'party', message: 'Too many party lookups. Please wait a minute and try again.' } },
      }]);
    }
    // Nothing happened: the party is still open, with its host.
    expect((await request('POST', '/v1/parties/lookup', { body: { code: code }, token: host.token })).body).toMatchObject({ isHost: true, deletedAt: null, isClosed: false });
  });

  it('count old 5-letter codes against the stricter limit too', async () => {
    const user = await signIn();
    const strict = testEnv({ LEGACY_CODE_LOOKUP_RATE_LIMIT_IP: denied });
    for (const action of ['join', 'leave', 'draw', 'delete', 'restore']) {
      expect([action, (await write(user.token, action, 'QWERT', strict)).status]).toEqual([action, 429]);
    }
    expect((await write(user.token, 'leave', 'QWERTYUI', strict)).status).toBe(404);
  });
});

describe('starting parties', () => {
  const remove = (token: string, code: string) => request('POST', '/v1/parties/delete', { token, body: { code } });

  it(`allows ${MAX_NEW_PARTIES_PER_DAY} a day per person, deleted ones included; repeats and restores don't count`, async () => {
    const host = await signIn();
    const key = crypto.randomUUID();
    const first = await request('POST', '/v1/parties', { token: host.token, key, body: { name: 'Again' } });
    expect((await request('POST', '/v1/parties', { token: host.token, key, body: { name: 'Again' } })).body.code).toBe(first.body.code);
    await remove(host.token, first.body.code);
    for (let i = 1; i < MAX_NEW_PARTIES_PER_DAY; i++) {
      const { code } = await create(host.token);
      await remove(host.token, code);
    }
    expect(await request('POST', '/v1/parties', { token: host.token, body: { name: 'One too many' } })).toMatchObject({
      status: 429, body: { error: { code: 'rate_limited', message: "You've started a lot of parties today. Please try again tomorrow." } },
    });
    // Restoring a deleted party isn't starting a new one.
    expect((await request('POST', '/v1/parties/restore', { token: host.token, body: { code: first.body.code } })).status).toBe(200);

    await runInDurableObject(env.USER.getByName(host.email), async (_i, state) => {
      state.storage.sql.exec('UPDATE party_starts SET at = at - ?', PARTY_STARTS_WINDOW_MS);
    });
    expect((await request('POST', '/v1/parties', { token: host.token, body: { name: 'Next day' } })).status).toBe(201);
  });

  it('reports the open-party limit first when both apply', async () => {
    const host = await signIn();
    for (let i = 0; i < MAX_OPEN_HOSTED_PARTIES; i++) {
      await create(host.token);
    }
    expect(await request('POST', '/v1/parties', { token: host.token, body: { name: 'Fourth' } })).toMatchObject({ status: 409, body: { error: { code: 'conflict' } } });
  });
});
