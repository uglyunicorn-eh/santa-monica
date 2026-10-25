import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { ApolloContext } from 'src/apollo/context';
import mutations from 'src/apollo/mutations';
import resolvers from 'src/apollo/resolvers';
import { MAX_PARTY_LOOKUPS, PARTY_CODE_RE } from 'src/apollo/resolvers/party';
import { MAX_PHRASE_GUESSES, PHRASE_GUESS_WINDOW_MS } from 'src/do/PartyDO';
import { app } from 'src/index';
import { createJwtHelpers } from 'src/utils/jwt';

import { domain } from 'src/config.json';

const jwt = createJwtHelpers({ privateKey: env.JWT_PRIVATE_KEY, issuer: domain });
let counter = 0;

const allow = { limit: async () => ({ success: true }) };
const deny = { limit: async () => ({ success: false }) };

async function signedIn(name = 'Person', overrides: Partial<ApolloContext> = {}): Promise<ApolloContext> {
  const email = `limits-${Date.now().toString(36)}-${++counter}@example.com`;
  const user = await env.USER.getByName(email).ensure(email);
  await env.USER.getByName(email).apply([{ type: 'setName', name }]);
  return {
    env, clientIp: `203.0.113.${++counter % 250}`, userId: user.id, userEmail: email,
    retrieveUser: async () => await env.USER.getByName(email).get(),
    sendMail: async () => undefined,
    ...jwt,
    ...overrides,
  };
}

const { parties } = mutations.Mutation;
const { party } = resolvers.Query;
const create = async (ctx: ApolloContext, password?: string) =>
  (await parties(null, {}, ctx).createParty({ input: { name: 'Limits', password } }, ctx) as any).node;
const join = async (ctx: ApolloContext, id: string, password?: string) =>
  await parties(null, {}, ctx).joinParty({ input: { party: id, name: 'Guest', password } }, ctx) as any;

describe('party codes', () => {
  it('gives new parties 8-letter codes and still accepts 5-letter ones', async () => {
    const host = await signedIn('Host');
    const { code } = await create(host);
    expect(code).toMatch(/^[A-Z]{8}$/);
    expect(PARTY_CODE_RE.test(code)).toBe(true);
    expect(PARTY_CODE_RE.test('QWERT')).toBe(true);
    for (const bad of ['QWER', 'QWERTY', 'QWERTYU', 'QWERTYUIP', 'qwertyui']) {
      expect(PARTY_CODE_RE.test(bad)).toBe(false);
    }
  });
});

describe('looking up parties', () => {
  type LookupResult = { data: Record<string, unknown> | null; errors?: { message: string; extensions: { code: string } }[] };
  const lookup = async (codes: string[], ip: string): Promise<LookupResult> => await (await app.request('/graph/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ query: `{ ${codes.map((code, i) => `p${i}: party(code: "${code}") { code }`).join(' ')} }` }),
  }, env)).json() as LookupResult;

  it(`answers at most ${MAX_PARTY_LOOKUPS} different codes per request`, async () => {
    const codes = Array.from({ length: MAX_PARTY_LOOKUPS + 2 }, (_, i) => `QQQQ${'WERTYUIPASDF'[i]}`);
    const res = await lookup(codes, '198.51.100.201');
    expect(res.errors).toHaveLength(2);
    expect(res.errors!.every(e => e.extensions.code === 'BAD_USER_INPUT' && /At most 10 parties/.test(e.message))).toBe(true);
  });

  it('counts the same code asked for twice once', async () => {
    const res = await lookup(Array.from({ length: MAX_PARTY_LOOKUPS * 2 }, () => 'QQQQQ'), '198.51.100.202');
    expect(res.errors).toBeUndefined();
  });

  it('refuses lookups once the client is over its rate limit', async () => {
    const ctx = await signedIn('Scanner', { env: { ...env, PARTY_LOOKUP_RATE_LIMIT_IP: deny } as typeof env });
    await expect(party(null, { code: 'QQQQQ' }, ctx)).rejects.toMatchObject({
      message: 'Too many party lookups. Please wait a minute and try again.',
      extensions: { code: 'RATE_LIMITED' },
    });
  });
});

describe('joining', () => {
  it('refuses joins once the user is over their rate limit', async () => {
    const host = await signedIn('Host');
    const { id } = await create(host);
    const guest = await signedIn('Guest', { env: { ...env, JOIN_RATE_LIMIT_USER: deny } as typeof env });
    expect(await join(guest, id)).toEqual({
      status: 'error',
      userErrors: [{ fieldName: 'party', messages: ["Whoa, that's a lot of tries! Please wait a minute and try again."] }],
    });
  });

  describe('secret phrase guesses', () => {
    const guestWithoutRateLimit = () => signedIn('Guesser', { env: { ...env, JOIN_RATE_LIMIT_USER: allow } as typeof env });
    const wrong = { status: 'error', userErrors: [{ fieldName: 'password', messages: [expect.stringMatching(/wrong secret phrase/)] }] };
    const locked = (minutes: number) => ({
      status: 'error',
      userErrors: [{ fieldName: 'password', messages: [`That's a lot of wrong guesses! Please ask your friend for the secret phrase and try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`] }],
    });
    /** Moves this person's first wrong guess back in time. */
    const firstGuessAgo = (code: string, memberId: string, ms: number) => runInDurableObject(env.PARTY.getByName(code), async (_i, state) => {
      state.storage.sql.exec('UPDATE phrase_guesses SET first_failed_at = ? WHERE member_id = ?', Date.now() - ms, memberId);
    });

    it(`allows ${MAX_PHRASE_GUESSES} wrong guesses, then makes the guesser wait, even with the right phrase`, async () => {
      const host = await signedIn('Host');
      const { id } = await create(host, 'mistletoe');
      const guest = await guestWithoutRateLimit();
      for (let i = 0; i < MAX_PHRASE_GUESSES; i++) {
        expect(await join(guest, id, `guess ${i}`)).toMatchObject(wrong);
      }
      expect(await join(guest, id, 'mistletoe')).toEqual(locked(15));

      // Another person is not affected.
      expect((await join(await guestWithoutRateLimit(), id, 'mistletoe')).status).toBe('ok');
    });

    it('lets the guesser try again once the window has passed, and forgets their guesses when they get it right', async () => {
      const host = await signedIn('Host');
      const { id, code } = await create(host, 'mistletoe');
      const guest = await guestWithoutRateLimit();
      for (let i = 0; i < MAX_PHRASE_GUESSES; i++) {
        await join(guest, id, `guess ${i}`);
      }
      await firstGuessAgo(code, guest.userId!, PHRASE_GUESS_WINDOW_MS - 30_000);
      expect(await join(guest, id, 'mistletoe')).toEqual(locked(1));

      await firstGuessAgo(code, guest.userId!, PHRASE_GUESS_WINDOW_MS + 1000);
      expect((await join(guest, id, 'mistletoe')).status).toBe('ok');
      expect(await runInDurableObject(env.PARTY.getByName(code), async (_i, state) =>
        state.storage.sql.exec('SELECT COUNT(*) AS n FROM phrase_guesses').one().n)).toBe(0);
    });

    it('starts counting again after a quiet window', async () => {
      const host = await signedIn('Host');
      const { id, code } = await create(host, 'mistletoe');
      const guest = await guestWithoutRateLimit();
      for (let i = 0; i < MAX_PHRASE_GUESSES - 1; i++) {
        await join(guest, id, `guess ${i}`);
      }
      await firstGuessAgo(code, guest.userId!, PHRASE_GUESS_WINDOW_MS + 1000);
      // The window passed, so this wrong guess is the first of a new one, not the fifth.
      expect(await join(guest, id, 'nope')).toMatchObject(wrong);
      expect(await join(guest, id, 'nope again')).toMatchObject(wrong);
      expect(await runInDurableObject(env.PARTY.getByName(code), async (_i, state) =>
        state.storage.sql.exec('SELECT failures FROM phrase_guesses').one().failures)).toBe(2);
    });
  });
});
