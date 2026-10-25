import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { routeList } from 'src/api';
import { PartyDO, RESTORE_WINDOW_MS } from 'src/do/PartyDO';
import { UserUpdate } from 'src/do/types';
import { Session } from 'src/utils/session';

import { jwt, mailer, request, signIn, testEnv, uniqueEmail } from './helpers';

type Call = { binding: 'PARTY' | 'USER'; name: string; method: string };

/** Wraps the PARTY and USER bindings so a test can count the Durable Object calls a request makes. */
function countingEnv(overrides: Partial<typeof env> = {}) {
  const calls: Call[] = [];
  const wrap = (binding: Call['binding'], namespace: { getByName(name: string): object }) => ({
    getByName: (name: string) => {
      const stub = namespace.getByName(name);
      return new Proxy(stub, {
        get: (target, method: string) => (...args: unknown[]) => {
          calls.push({ binding, name, method });
          return (target as any)[method](...args);
        },
      });
    },
  });
  return {
    calls,
    env: testEnv({ PARTY: wrap('PARTY', env.PARTY) as any, USER: wrap('USER', env.USER) as any, EMAIL: mailer().EMAIL, ...overrides }),
    count: (binding?: Call['binding']) => calls.filter(c => !binding || c.binding === binding).length,
    methods: () => calls.map(c => `${c.binding}.${c.method}`),
    reset: () => { calls.length = 0; },
  };
}

const person = (name = 'Person') => signIn(uniqueEmail('eff'), name);
const create = async (token: string, name = 'Party') => (await request('POST', '/v1/parties', { token, body: { name } })).body;
const join = (token: string, code: string, name = 'Guest') => request('POST', '/v1/parties/join', { token, body: { code: code, name } });
const key = () => crypto.randomUUID();

/** Runs a party's alarm until its outbox is empty. */
const settle = async (code: string) => {
  for (let i = 0; i < 20 && await env.PARTY.getByName(code).pendingOutbox(); i++) {
    await runDurableObjectAlarm(env.PARTY.getByName(code));
  }
};

/**
 * Worker → Durable Object calls per route: exact counts by binding. Every route the API serves has a row (checked
 * below). "+n" routes fan out to each of the user's parties, one call each, by design.
 */
const BUDGETS: Record<string, { USER: number | string; PARTY: number | string }> = {
  'POST /auth/magic-link': { USER: '1, or 2 with an Idempotency-Key', PARTY: '0, or 1 with a party code' },
  'POST /auth/session': { USER: 1, PARTY: 0 },
  'GET /me': { USER: 1, PARTY: 0 },
  'PATCH /me': { USER: 1, PARTY: 0 },
  'GET /me/parties': { USER: 1, PARTY: 0 },
  'POST /me/deletion': { USER: 1, PARTY: 0 },
  'POST /me/email-change': { USER: 2, PARTY: 0 },
  'POST /me/deletion/confirm': { USER: 2, PARTY: '1 per party' },
  'POST /me/email-change/confirm': { USER: 4, PARTY: '1 per party' },
  'POST /me/email-change/cancel': { USER: 1, PARTY: 0 },
  'GET /parties': { USER: '0 anonymous, 1 signed in', PARTY: 1 },
  'POST /parties': { USER: 1, PARTY: 1 },
  'POST /parties/join': { USER: 0, PARTY: 1 },
  'POST /parties/leave': { USER: 1, PARTY: 1 },
  'POST /parties/draw': { USER: 1, PARTY: 1 },
  'POST /parties/delete': { USER: 1, PARTY: 1 },
  'POST /parties/restore': { USER: 1, PARTY: 2 },
};

describe('Durable Object call budgets', () => {
  it('has a budget for every route the API serves', () => {
    expect(new Set(routeList().filter(r => !r.includes('/__test')))).toEqual(new Set(Object.keys(BUDGETS)));
  });

  it('POST /auth/magic-link: one (count the email), two with a key (look up, then claim and count), one more with a party code', async () => {
    const host = await person();
    const party = await create(host.token);
    const counting = countingEnv();
    expect((await request('POST', '/v1/auth/magic-link', { body: { email: uniqueEmail() }, env: counting.env })).status).toBe(202);
    expect(counting.methods()).toEqual(['USER.countMail']);

    counting.reset();
    const k = key();
    const email = uniqueEmail();
    await request('POST', '/v1/auth/magic-link', { key: k, body: { email, party: party.code }, env: counting.env });
    expect(counting.methods()).toEqual(['USER.seenMailRequest', 'PARTY.view', 'USER.claimMailRequest']);

    counting.reset();
    await request('POST', '/v1/auth/magic-link', { key: k, body: { email, party: party.code }, env: counting.env });
    expect(counting.methods()).toEqual(['USER.seenMailRequest']);
  });

  it('POST /auth/session: one call, whether the link is fresh, used or repeated; none when it is invalid', async () => {
    const email = uniqueEmail();
    const token = await jwt().issueToken('EnterRequest', { email, jti: crypto.randomUUID() }, { ttl: 60 });
    const counting = countingEnv();
    const k = key();
    for (const options of [{ key: k }, { key: k }, {}]) {
      counting.reset();
      await request('POST', '/v1/auth/session', { ...options, body: { token }, env: counting.env });
      expect(counting.calls).toEqual([{ binding: 'USER', name: email, method: 'redeemMagicLink' }]);
    }
    counting.reset();
    await request('POST', '/v1/auth/session', { body: { token: 'garbage' }, env: counting.env });
    expect(counting.count()).toBe(0);
  });

  it('GET and PATCH /me, GET /me/parties: one call each (the rename and the list check the session themselves)', async () => {
    const who = await person('Me');
    await create(who.token);
    const counting = countingEnv();
    await request('GET', '/v1/me', { token: who.token, env: counting.env });
    await request('PATCH', '/v1/me', { token: who.token, body: { name: 'Renamed' }, env: counting.env });
    await request('GET', '/v1/me/parties', { token: who.token, env: counting.env });
    expect(counting.methods()).toEqual(['USER.get', 'USER.updateName', 'USER.listParties']);

    counting.reset();
    expect((await request('GET', '/v1/me', { env: counting.env })).status).toBe(401);
    expect(counting.count()).toBe(0);
  });

  it('POST /me/deletion: one call (session, request id, email cap); /me/email-change: one more for the new address', async () => {
    const who = await person();
    const counting = countingEnv();
    expect((await request('POST', '/v1/me/deletion', { token: who.token, key: key(), env: counting.env })).status).toBe(202);
    expect(counting.methods()).toEqual(['USER.beginMailRequest']);

    counting.reset();
    const newEmail = uniqueEmail('new');
    expect((await request('POST', '/v1/me/email-change', { token: who.token, body: { email: newEmail }, env: counting.env })).status).toBe(202);
    expect(counting.calls.map(c => `${c.name === who.email ? 'old' : 'new'}.${c.method}`)).toEqual(['old.beginMailRequest', 'new.checkRecipient']);
  });

  it('POST /me/email-change/cancel: one call, fresh or repeated; none for an invalid link', async () => {
    const who = await person();
    const token = await jwt().issueToken('EmailChangeCancel', { sub: who.nodeId, email: who.email, jti: crypto.randomUUID() }, { ttl: 60 });
    const counting = countingEnv();
    const k = key();
    for (let i = 0; i < 2; i++) {
      counting.reset();
      expect((await request('POST', '/v1/me/email-change/cancel', { key: k, body: { token }, env: counting.env })).status).toBe(200);
      expect(counting.methods()).toEqual(['USER.cancelAccountChange']);
    }
    counting.reset();
    await request('POST', '/v1/me/email-change/cancel', { body: { token: 'garbage' }, env: counting.env });
    expect(counting.count()).toBe(0);
  });

  it('confirming a deletion: two calls to the user and one per party, however many parties', async () => {
    for (const parties of [1, 3]) {
      const who = await person();
      for (let i = 0; i < parties; i++) {
        await create(who.token, `P${i}`);
      }
      const token = await jwt().issueToken('AccountDeletion', { sub: who.nodeId, email: who.email, jti: crypto.randomUUID(), ver: 0 }, { ttl: 60 });
      const counting = countingEnv();
      expect((await request('POST', '/v1/me/deletion/confirm', { body: { token }, env: counting.env })).status).toBe(200);
      expect([counting.count('USER'), counting.count('PARTY')]).toEqual([2, parties]);
      expect(counting.methods().filter(m => m.startsWith('USER'))).toEqual(['USER.startAccountChange', 'USER.tombstone']);
    }
  });

  it('confirming an email change: four calls to the two addresses and one per party, however many parties', async () => {
    for (const parties of [1, 3]) {
      const who = await person();
      for (let i = 0; i < parties; i++) {
        await create(who.token, `P${i}`);
      }
      const newEmail = uniqueEmail('moved');
      const token = await jwt().issueToken('EmailChange', { sub: who.nodeId, email: who.email, newEmail, jti: crypto.randomUUID(), ver: 0 }, { ttl: 60 });
      const counting = countingEnv();
      expect((await request('POST', '/v1/me/email-change/confirm', { body: { token }, env: counting.env })).status).toBe(200);
      expect([counting.count('USER'), counting.count('PARTY')]).toEqual([4, parties]);
      expect(counting.calls.filter(c => c.binding === 'USER').map(c => `${c.name === who.email ? 'old' : 'new'}.${c.method}`))
        .toEqual(['new.get', 'old.startAccountChange', 'new.receive', 'old.tombstone']);
    }
  });

  it('GET /parties: one call anonymous, two signed in (made at the same time), whatever the party holds', async () => {
    for (const members of [1, 12]) {
      const host = await person('Host');
      const party = await create(host.token);
      for (let i = 1; i < members; i++) {
        await join((await person()).token, party.code);
      }
      const counting = countingEnv();
      await request('GET', `/v1/parties?code=${party.code}`, { env: counting.env });
      expect(counting.methods()).toEqual(['PARTY.view']);
      counting.reset();
      const { body } = await request('GET', `/v1/parties?code=${party.code}`, { token: host.token, env: counting.env });
      expect(body.participants).toHaveLength(members);
      expect(counting.methods().sort()).toEqual(['PARTY.view', 'USER.get']);
    }
  });

  it('POST /parties: a held slot and the party; join: one call (the party checks the session itself)', async () => {
    const host = await person('Host');
    const guest = await person('Guest');
    const counting = countingEnv();
    const { body: party } = await request('POST', '/v1/parties', { token: host.token, body: { name: 'Create' }, env: counting.env });
    expect(counting.methods()).toEqual(['USER.startHosting', 'PARTY.create']);
    counting.reset();
    await request('POST', '/v1/parties/join', { token: guest.token, body: { code: party.code, name: 'G' }, env: counting.env });
    expect(counting.methods()).toEqual(['PARTY.join']);

    // A deleted account's join is refused in that same call.
    const ghost = await person();
    await env.USER.getByName(ghost.email).tombstone();
    counting.reset();
    expect((await request('POST', '/v1/parties/join', { token: ghost.token, body: { code: party.code, name: 'G' }, env: counting.env })).status).toBe(401);
    expect(counting.methods()).toEqual(['PARTY.join']);
  });

  it('leave, draw and delete: the session check and the party, whatever the party holds', async () => {
    for (const members of [2, 30]) {
      const host = await person('Host');
      const party = await create(host.token);
      const guests = [];
      for (let i = 1; i < members; i++) {
        const guest = await person();
        await join(guest.token, party.code);
        guests.push(guest);
      }
      const counting = countingEnv();
      await request('POST', '/v1/parties/leave', { body: { code: party.code }, token: guests[0].token, env: counting.env });
      await request('POST', '/v1/parties/draw', { body: { code: party.code }, token: host.token, env: counting.env });
      const other = await create(host.token, 'Other');
      counting.reset();
      await request('POST', '/v1/parties/delete', { body: { code: other.code }, token: host.token, env: counting.env });
      expect(counting.methods()).toEqual(['USER.get', 'PARTY.delete']);
    }
  });

  it('restore: the party, a slot (or the session check for a closed party), and the party again', async () => {
    const host = await person('Host');
    const guest = await person('Guest');
    const open = await create(host.token, 'Open');
    const closed = await create(host.token, 'Closed');
    await join(guest.token, closed.code);
    await request('POST', '/v1/parties/draw', { body: { code: closed.code }, token: host.token });
    await request('POST', '/v1/parties/delete', { body: { code: open.code }, token: host.token });
    // Rolled parties can't be deleted any more; this one was deleted before that rule.
    await runInDurableObject(env.PARTY.getByName(closed.code), async (instance: PartyDO) => {
      (instance as any).setDeleted(Date.now());
      await (instance as any).deliverSoon();
    });

    const counting = countingEnv();
    expect((await request('POST', '/v1/parties/restore', { body: { code: open.code }, token: host.token, env: counting.env })).status).toBe(200);
    expect(counting.methods()).toEqual(['PARTY.view', 'USER.startHosting', 'PARTY.restore']);
    counting.reset();
    expect((await request('POST', '/v1/parties/restore', { body: { code: closed.code }, token: host.token, env: counting.env })).status).toBe(200);
    expect(counting.methods()).toEqual(['PARTY.view', 'USER.get', 'PARTY.restore']);
    // The slot held for the open party was released when it came back to the host's list.
    expect(await runInDurableObject(env.USER.getByName(host.email), async (_i, state) =>
      state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM host_reservations').one().n)).toBe(0);
  });

  it('repeats cost no more than the first request', async () => {
    const host = await person('Host');
    const guest = await person('Guest');
    const party = await create(host.token);
    await join(guest.token, party.code);
    for (const [method, path, body] of [
      ['POST', '/v1/parties/join', { code: party.code, name: 'G' }],
      ['POST', '/v1/parties/draw', { code: party.code }],
    ] as const) {
      const token = method === 'POST' && path.endsWith('/join') ? guest.token : host.token;
      const first = countingEnv();
      await request(method, path, { token, body, env: first.env });
      const again = countingEnv();
      await request(method, path, { token, body, env: again.env });
      expect(again.count()).toBeLessThanOrEqual(first.count());
    }
  });
});

describe('lists do not grow with what is in them (no N+1)', () => {
  it('lists my parties with one call, from 1 to 6 parties, joined or hosted', async () => {
    for (const size of [1, 6]) {
      const who = await person('Me');
      for (let i = 0; i < size; i++) {
        if (i < 3) {
          await create(who.token, `Mine ${i}`);
        } else {
          const other = await person();
          await join(who.token, (await create(other.token, `Theirs ${i}`)).code, 'Me');
        }
      }
      const counting = countingEnv();
      const { body } = await request('GET', '/v1/me/parties?first=100', { token: who.token, env: counting.env });
      expect(body.items).toHaveLength(size);
      expect(counting.calls).toEqual([{ binding: 'USER', name: who.email, method: 'listParties' }]);
    }
  });

  it('gives party times in the list from the summaries alone', async () => {
    const who = await person('Me');
    const friend = await person('Friend');
    const party = await create(who.token, 'Timed');
    await join(friend.token, party.code);
    await request('POST', '/v1/parties/draw', { body: { code: party.code }, token: who.token });
    await settle(party.code);
    const counting = countingEnv();
    const { body } = await request('GET', '/v1/me/parties', { token: who.token, env: counting.env });
    expect(body.items).toMatchObject([{ code: party.code, createdAt: expect.any(String), rolledAt: expect.any(String) }]);
    expect(counting.methods()).toEqual(['USER.listParties']);
  });
});

/** Wraps a party's USER binding with a recorder, to count the calls the party makes to users. */
const recordUserCalls = (code: string) => {
  const applied: { email: string; updates: UserUpdate[] }[] = [];
  const done = runInDurableObject(env.PARTY.getByName(code), async (instance: PartyDO) => {
    const self = instance as unknown as { env: typeof env };
    const users = self.env.USER;
    self.env = {
      ...self.env,
      USER: {
        getByName: (email: string) => ({
          apply: async (updates: UserUpdate[], session?: Session) => {
            applied.push({ email, updates });
            return await users.getByName(email).apply(updates, session);
          },
        }),
      },
      EMAIL: { send: async () => ({ messageId: 'm' }) },
    } as unknown as typeof env;
  });
  return { applied, done };
};

describe('party → user updates', () => {
  it('sends one call per user, with all their changes batched, and keeps each user\'s summary right', async () => {
    const host = await person('Host');
    const guest = await person('Guest');
    const party = await create(host.token, 'Batched');

    const { applied, done } = recordUserCalls(party.code);
    await done;
    await join(guest.token, party.code, 'Guesty');

    // One call to the guest's UserDO: the party summary and the name, sent with the session, which the UserDO checks.
    expect(applied).toEqual([{
      email: guest.email,
      updates: [
        { type: 'addParty', party: expect.objectContaining({ slug: party.code, name: 'Batched', isHost: false, isClosed: false, isProtected: false }) },
        { type: 'setNameIfEmpty', name: 'Guesty', userId: guest.id },
      ],
    }]);
    // The guest already had a profile name: joining doesn't overwrite it.
    expect((await env.USER.getByName(guest.email).get())!.name).toBe('Guest');
  });

  it('draws a 30-person party with one update per member, not one per change', async () => {
    const host = await person('Host');
    const party = await create(host.token, 'Big draw');
    const guests = [];
    for (let i = 1; i < 30; i++) {
      const guest = await person();
      await join(guest.token, party.code);
      guests.push(guest);
    }
    const { applied, done } = recordUserCalls(party.code);
    await done;
    await request('POST', '/v1/parties/draw', { body: { code: party.code }, token: host.token });
    await runInDurableObject(env.PARTY.getByName(party.code), async (instance: PartyDO) => { await instance.alarm(); });
    expect(applied).toHaveLength(30);
    expect(new Set(applied.map(a => a.email)).size).toBe(30);
    for (const p of [host, guests[0]]) {
      const [summary] = (await env.USER.getByName(p.email).listParties(10))!;
      expect(summary).toMatchObject({ slug: party.code, isClosed: true, isHost: p === host });
    }
  });

  it("deletes with one call from the Worker beyond the session check: the host's list updates before it returns, the guests' on the alarm", async () => {
    const host = await person('Host');
    const guest = await person('Guest');
    const party = await create(host.token, 'Deleted');
    await join(guest.token, party.code);
    const { applied, done } = recordUserCalls(party.code);
    await done;
    expect((await request('POST', '/v1/parties/delete', { body: { code: party.code }, token: host.token })).status).toBe(200);
    expect(applied).toEqual([{ email: host.email, updates: [{ type: 'addParty', party: expect.objectContaining({ slug: party.code, deletedAt: expect.any(Number) }) }] }]);

    await runInDurableObject(env.PARTY.getByName(party.code), async (instance: PartyDO) => { await instance.alarm(); });
    expect(applied.slice(1)).toEqual([{ email: guest.email, updates: [{ type: 'removeParty', slug: party.code }] }]);
  });

  it('sends nothing for a sync left queued for a party that was erased', async () => {
    const host = await person('Host');
    const party = await create(host.token, 'Gone');
    await request('POST', '/v1/parties/delete', { body: { code: party.code }, token: host.token });
    await runInDurableObject(env.PARTY.getByName(party.code), async (instance: PartyDO, state) => {
      state.storage.sql.exec('UPDATE party SET deleted_at = ?', Date.now() - RESTORE_WINDOW_MS - 1000);
      await instance.alarm();
    });
    expect(await env.USER.getByName(host.email).listParties(10)).toEqual([]);

    const { applied, done } = recordUserCalls(party.code);
    await done;
    await runInDurableObject(env.PARTY.getByName(party.code), async (instance: PartyDO, state) => {
      state.storage.sql.exec('INSERT INTO outbox (payload, next_attempt_at) VALUES (?, 0)', JSON.stringify({ kind: 'user.sync', email: host.email }));
      await instance.alarm();
      expect(await instance.pendingOutbox()).toBe(0);
    });
    expect(applied).toEqual([]);
  });

  it('holds the limit when one host creates parties in parallel', async () => {
    const host = await person('Host');
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => request('POST', '/v1/parties', { token: host.token, body: { name: `Rush ${i}` } })));
    expect(results.map(r => r.status).sort()).toEqual([201, 201, 201, 409, 409]);
    expect(await env.USER.getByName(host.email).listParties(10)).toHaveLength(3);
  });

  it('releases the held slot once the party is in the list, and drops slots that expire', async () => {
    const host = await person('Host');
    const reservations = () => runInDurableObject(env.USER.getByName(host.email), async (_i, state) =>
      state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM host_reservations').one().n);

    await create(host.token, 'One');
    expect(await reservations()).toBe(0);

    // Two slots held by creates that never finished: only the expired one stops counting.
    await runInDurableObject(env.USER.getByName(host.email), async (_i, state) => {
      state.storage.sql.exec("INSERT INTO host_reservations (id, expires_at) VALUES ('stale', 1), ('live', ?)", Date.now() + 60_000);
    });
    expect((await request('POST', '/v1/parties', { token: host.token, body: { name: 'Two' } })).status).toBe(201);
    expect((await request('POST', '/v1/parties', { token: host.token, body: { name: 'Three' } })).status).toBe(409);
    expect(await reservations()).toBe(1);
  });

  it('frees the slot on delete and close even while an earlier update to the host waits for a retry', async () => {
    const host = await person('Host');
    const guest = await person('Guest');
    const waiting = (code: string) => runInDurableObject(env.PARTY.getByName(code), async (_i, state) => {
      state.storage.sql.exec('INSERT INTO outbox (payload, attempts, next_attempt_at) VALUES (?, 1, ?)', JSON.stringify({ kind: 'user.sync', email: host.email }), Date.now() + 60_000);
    });
    const outbox = (code: string) => runInDurableObject(env.PARTY.getByName(code), async (instance: PartyDO) => await instance.pendingOutbox());

    const deleted = await create(host.token, 'To delete');
    await waiting(deleted.code);
    await request('POST', '/v1/parties/delete', { body: { code: deleted.code }, token: host.token });
    expect(await outbox(deleted.code)).toBe(0);

    const closed = await create(host.token, 'To close');
    await join(guest.token, closed.code);
    await waiting(closed.code);
    await request('POST', '/v1/parties/draw', { body: { code: closed.code }, token: host.token });

    const list = (await env.USER.getByName(host.email).listParties(10))!;
    expect(list.find(p => p.slug === deleted.code)!.deletedAt).toEqual(expect.any(Number));
    expect(list.find(p => p.slug === closed.code)!.isClosed).toBe(true);
  });

  it('removes the party from the list of someone who left', async () => {
    const host = await person('Host');
    const guest = await person('Guest');
    const party = await create(host.token, 'Leaving');
    await join(guest.token, party.code);
    await request('POST', '/v1/parties/leave', { body: { code: party.code }, token: guest.token });
    expect(await env.USER.getByName(guest.email).listParties(10)).toEqual([]);
  });
});

describe('party lists saved before summaries existed', () => {
  it('fills in missing summaries once, from the parties, and stores them', async () => {
    const who = await person('Me');
    const party = await create(who.token, 'Old row');
    await runInDurableObject(env.USER.getByName(who.email), async (_i, state) => {
      state.storage.sql.exec('UPDATE parties SET is_host = NULL, is_protected = NULL, is_closed = NULL');
    });

    const first = countingEnv();
    const { body } = await request('GET', '/v1/me/parties', { token: who.token, env: first.env });
    expect(body.items).toMatchObject([{ code: party.code, name: 'Old row', isHost: true, isClosed: false }]);
    expect(first.methods().sort()).toEqual(['PARTY.view', 'USER.apply', 'USER.listParties']);

    const second = countingEnv();
    await request('GET', '/v1/me/parties', { token: who.token, env: second.env });
    expect(second.methods()).toEqual(['USER.listParties']);
  });

  it('skips parties that no longer exist while filling in', async () => {
    const who = await person('Me');
    await env.USER.getByName(who.email).apply([{ type: 'addParty', party: { slug: 'QQQQZ', name: 'Gone', createdAt: 1, isHost: false, isProtected: false, isClosed: false, closedAt: null } }]);
    await runInDurableObject(env.USER.getByName(who.email), async (_i, state) => {
      state.storage.sql.exec('UPDATE parties SET is_host = NULL');
    });
    expect((await request('GET', '/v1/me/parties', { token: who.token })).body.items).toEqual([]);
  });

  it('adds the summary and request columns to existing tables', async () => {
    const email = uniqueEmail('migrate');
    const stub = env.USER.getByName(email);
    await stub.ensure(email);
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec('DROP TABLE parties');
      state.storage.sql.exec('CREATE TABLE parties (slug TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)');
      state.storage.sql.exec("INSERT INTO parties VALUES ('QQQQY', 'Before', 5)");
      state.storage.sql.exec('DROP TABLE used_magic_links');
      state.storage.sql.exec('CREATE TABLE used_magic_links (jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
      state.storage.sql.exec('DROP TABLE create_requests');
      state.storage.sql.exec('CREATE TABLE create_requests (key TEXT PRIMARY KEY, party_id TEXT NOT NULL, slug TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    });
    await evictDurableObject(stub);
    expect(await env.USER.getByName(email).listParties(10)).toEqual([
      { slug: 'QQQQY', name: 'Before', createdAt: 5, isHost: null, isProtected: null, isClosed: null, closedAt: null, deletedAt: null },
    ]);
    expect(await env.USER.getByName(email).redeemMagicLink(email, 'j', Date.now() + 60_000, 'hash')).toMatchObject({ email });
  });
});
