import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { UserToken } from 'src/apollo/types';
import { PartyDO } from 'src/do/PartyDO';
import { UserUpdate } from 'src/do/types';
import { app } from 'src/index';
import { createJwtHelpers } from 'src/utils/jwt';
import { Session } from 'src/utils/session';
import { nodeIdToStr } from 'src/utils/strings/nodeId';

import { domain } from 'src/config.json';

type Call = { binding: 'PARTY' | 'USER'; name: string; method: string };

/** Wraps the PARTY and USER bindings so a test can count the Durable Object calls a request makes. */
function countingEnv() {
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
    env: { ...env, PARTY: wrap('PARTY', env.PARTY), USER: wrap('USER', env.USER) } as typeof env,
    count: (binding?: Call['binding']) => calls.filter(c => !binding || c.binding === binding).length,
    reset: () => { calls.length = 0; },
  };
}

const jwt = createJwtHelpers({ privateKey: env.JWT_PRIVATE_KEY, issuer: domain });
let counter = 0;

async function person(name: string) {
  const email = `eff-${Date.now().toString(36)}-${++counter}@example.com`;
  const user = await env.USER.getByName(email).ensure(email);
  await env.USER.getByName(email).apply([{ type: 'setName', name }]);
  const token = await jwt.issueToken<UserToken>('UserToken', { sub: nodeIdToStr({ kind: 'User', id: user.id }), email }, { ttl: 3600 });
  return { email, id: user.id, token };
}

async function gql(bindings: typeof env, query: string, variables: Record<string, unknown> = {}, token?: string) {
  const res = await app.request('/graph/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
  }, bindings);
  return await res.json() as { data: any; errors?: unknown[] };
}

const CREATE = `mutation ($name: String!) { parties { createParty(input: { name: $name }) { status node { id code } } } }`;
const JOIN = `mutation ($party: ID!, $name: String!) { parties { joinParty(input: { party: $party, name: $name }) { status } } }`;
const LEAVE = `mutation ($party: ID!) { parties { leaveParty(input: { party: $party }) { status } } }`;
const CLOSE = `mutation ($party: ID!) { parties { closeParty(input: { party: $party }) { status } } }`;

/** Delivers a party's queued messages (user updates and mail) right away. */
const settle = async (code: string) => {
  for (let i = 0; i < 20 && await env.PARTY.getByName(code).pendingOutbox(); i++) {
    await runDurableObjectAlarm(env.PARTY.getByName(code));
  }
};

describe('Durable Object calls per operation', () => {
  it('lists my parties with one call, however many parties there are', async () => {
    const me = await person('Me');
    const counting = countingEnv();
    for (let i = 0; i < 6; i++) {
      await gql(env, CREATE, { name: `Party ${i}` }, me.token);
    }

    const list = await gql(counting.env, `{ parties { code name isHost isClosed isProtected isJoined } }`, {}, me.token);
    expect(list.data.parties).toHaveLength(6);
    expect(list.data.parties.every((p: any) => p.isHost && p.isJoined && !p.isClosed && !p.isProtected)).toBe(true);
    expect(counting.calls).toEqual([{ binding: 'USER', name: me.email, method: 'listParties' }]);
  });

  it('asks a party only for fields the summary does not carry, once per party', async () => {
    const me = await person('Me');
    for (let i = 0; i < 3; i++) {
      await gql(env, CREATE, { name: `Party ${i}` }, me.token);
    }
    const counting = countingEnv();
    const list = await gql(counting.env, `{ parties { code participantCount participants password } }`, {}, me.token);
    expect(list.data.parties.map((p: any) => p.participantCount)).toEqual([1, 1, 1]);
    expect(counting.count('USER')).toBe(1);
    expect(counting.calls.filter(c => c.binding === 'PARTY').map(c => c.method)).toEqual(['view', 'view', 'view']);
  });

  it('looks up a party with one call, whatever fields are asked for', async () => {
    const me = await person('Me');
    const created = await gql(env, CREATE, { name: 'One' }, me.token);
    const counting = countingEnv();
    const res = await gql(counting.env, `query ($code: String!) { party(code: $code) { name participantCount participants password target { id } isHost } }`, { code: created.data.parties.createParty.node.code }, me.token);
    expect(res.data.party).toMatchObject({ name: 'One', participantCount: 1, isHost: true });
    expect(counting.calls).toEqual([{ binding: 'PARTY', name: created.data.parties.createParty.node.code, method: 'view' }]);
  });

  it('joins with one call from the Worker (the party updates the user itself, in one call)', async () => {
    const host = await person('Host');
    const guest = await person('Guest');
    const { node } = (await gql(env, CREATE, { name: 'Join' }, host.token)).data.parties.createParty;
    const counting = countingEnv();
    expect((await gql(counting.env, JOIN, { party: node.id, name: 'Guesty' }, guest.token)).data.parties.joinParty.status).toBe('ok');
    expect(counting.calls).toEqual([{ binding: 'PARTY', name: node.code, method: 'join' }]);
  });

  it('creates a party with two calls: the host profile and the party', async () => {
    const host = await person('Host');
    const counting = countingEnv();
    await gql(counting.env, CREATE, { name: 'Create' }, host.token);
    expect(counting.calls.map(c => `${c.binding}.${c.method}`)).toEqual(['USER.get', 'PARTY.create']);
  });

  it('reads my profile with one call, and none without a session', async () => {
    const me = await person('Me');
    const counting = countingEnv();
    expect((await gql(counting.env, `{ user { id name email } }`, {}, me.token)).data.user).toMatchObject({ name: 'Me', email: me.email });
    expect(counting.calls).toEqual([{ binding: 'USER', name: me.email, method: 'get' }]);

    counting.reset();
    expect((await gql(counting.env, `{ user { id } parties { code } }`)).data).toEqual({ user: null, parties: null });
    expect(counting.count()).toBe(0);
  });

  it('signs in with one call, whether the link is fresh, used or invalid', async () => {
    const email = `eff-enter-${++counter}@example.com`;
    const token = await jwt.issueToken('EnterRequest', { email, jti: crypto.randomUUID() }, { ttl: 60 });
    const ENTER = `mutation ($token: String!) { auth { enter(input: { enterRequestToken: $token }) { status userToken user { id name } } } }`;
    const counting = countingEnv();

    expect((await gql(counting.env, ENTER, { token })).data.auth.enter.status).toBe('ok');
    expect(counting.calls).toEqual([{ binding: 'USER', name: email, method: 'redeemMagicLink' }]);

    counting.reset();
    expect((await gql(counting.env, ENTER, { token })).data.auth.enter.status).toBe('error');
    expect(counting.calls).toEqual([{ binding: 'USER', name: email, method: 'redeemMagicLink' }]);

    counting.reset();
    expect((await gql(counting.env, ENTER, { token: 'garbage' })).data.auth.enter.status).toBe('error');
    expect(counting.count()).toBe(0);
  });

  it('requests a magic link without touching any Durable Object', async () => {
    const counting = countingEnv();
    const bindings = { ...counting.env, EMAIL: { send: async () => ({ messageId: 'm' }) } } as unknown as typeof env;
    const res = await gql(bindings, `mutation ($email: String!) { auth { enterRequest(input: { email: $email }) { status } } }`, { email: `eff-link-${++counter}@example.com` });
    expect(res.data.auth.enterRequest.status).toBe('ok');
    expect(counting.count()).toBe(0);
  });

  it('updates the profile name with one call, which also checks the session', async () => {
    const me = await person('Me');
    const counting = countingEnv();
    const res = await gql(counting.env, `mutation { profile { updateName(input: { name: "Renamed" }) { status user { name } } } }`, {}, me.token);
    expect(res.data.profile.updateName).toEqual({ status: 'ok', user: { name: 'Renamed' } });
    expect(counting.calls).toEqual([{ binding: 'USER', name: me.email, method: 'updateName' }]);
  });

  it('reads a page of party history with one call', async () => {
    const me = await person('Me');
    for (let i = 0; i < 3; i++) {
      await gql(env, CREATE, { name: `Party ${i}` }, me.token);
    }
    const counting = countingEnv();
    const HISTORY = `query ($after: String) { partyHistory(first: 2, after: $after) { items { code name isHost } hasMore endCursor } }`;
    const first = (await gql(counting.env, HISTORY, {}, me.token)).data.partyHistory;
    const second = (await gql(counting.env, HISTORY, { after: first.endCursor }, me.token)).data.partyHistory;
    expect([first.items.length, first.hasMore, second.items.length, second.hasMore]).toEqual([2, true, 1, false]);
    expect(counting.calls.map(c => `${c.binding}.${c.method}`)).toEqual(['USER.listParties', 'USER.listParties']);
  });

  it('refuses a join from a deleted account with no extra call', async () => {
    const host = await person('Host');
    const guest = await person('Guest');
    const { node } = (await gql(env, CREATE, { name: 'Revoked' }, host.token)).data.parties.createParty;
    await env.USER.getByName(guest.email).tombstone();
    const counting = countingEnv();
    expect((await gql(counting.env, JOIN, { party: node.id, name: 'Ghost' }, guest.token)).data.parties.joinParty.status).toBe('error');
    expect(counting.calls).toEqual([{ binding: 'PARTY', name: node.code, method: 'join' }]);
  });

  it('leaves and closes with one call each', async () => {
    const host = await person('Host');
    const guest = await person('Guest');
    const other = await person('Other');
    const { node } = (await gql(env, CREATE, { name: 'Close' }, host.token)).data.parties.createParty;
    await gql(env, JOIN, { party: node.id, name: 'G' }, guest.token);
    await gql(env, JOIN, { party: node.id, name: 'O' }, other.token);
    const counting = countingEnv();
    await gql(counting.env, LEAVE, { party: node.id }, other.token);
    await gql(counting.env, CLOSE, { party: node.id }, host.token);
    expect(counting.calls.map(c => `${c.binding}.${c.method}`)).toEqual(['PARTY.leave', 'PARTY.close']);
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
    const { node } = (await gql(env, CREATE, { name: 'Batched' }, host.token)).data.parties.createParty;

    const { applied, done } = recordUserCalls(node.code);
    await done;
    await gql(env, JOIN, { party: node.id, name: 'Guesty' }, guest.token);

    // One call to the guest's UserDO: the party summary and the name, sent with the session, which the UserDO checks.
    expect(applied).toHaveLength(1);
    expect(applied[0]).toEqual({
      email: guest.email,
      updates: [
        { type: 'addParty', party: expect.objectContaining({ slug: node.code, name: 'Batched', isHost: false, isClosed: false, isProtected: false }) },
        { type: 'setNameIfEmpty', name: 'Guesty', userId: guest.id },
      ],
    });
    // The guest already had a profile name: joining doesn't overwrite it.
    expect((await env.USER.getByName(guest.email).get())!.name).toBe('Guest');
  });

  it('marks the party closed in every member\'s list when it closes', async () => {
    const host = await person('Host');
    const guest = await person('Guest');
    const { node } = (await gql(env, CREATE, { name: 'Closing' }, host.token)).data.parties.createParty;
    await gql(env, JOIN, { party: node.id, name: 'G' }, guest.token);
    await gql(env, CLOSE, { party: node.id }, host.token);
    await settle(node.code);

    for (const p of [host, guest]) {
      const [summary] = await env.USER.getByName(p.email).listParties(10);
      expect(summary).toMatchObject({ slug: node.code, isClosed: true, isHost: p === host });
    }
  });

  it('removes the party from the list of someone who left', async () => {
    const host = await person('Host');
    const guest = await person('Guest');
    const { node } = (await gql(env, CREATE, { name: 'Leaving' }, host.token)).data.parties.createParty;
    await gql(env, JOIN, { party: node.id, name: 'G' }, guest.token);
    await gql(env, LEAVE, { party: node.id }, guest.token);
    expect(await env.USER.getByName(guest.email).listParties(10)).toEqual([]);
  });

  it('delivers older queued messages (from before summaries) as one sync per user', async () => {
    const host = await person('Host');
    const { node } = (await gql(env, CREATE, { name: 'Legacy' }, host.token)).data.parties.createParty;
    // Record first, then deliver by calling the alarm handler directly: a real alarm could fire before the recorder is in place.
    const { applied, done } = recordUserCalls(node.code);
    await done;
    await runInDurableObject(env.PARTY.getByName(node.code), async (instance: PartyDO, state) => {
      for (const kind of ['user.removeParty', 'user.addParty']) {
        state.storage.sql.exec('INSERT INTO outbox (payload, next_attempt_at) VALUES (?, 0)', JSON.stringify({ kind, email: host.email, party: { slug: node.code } }));
      }
      await instance.alarm();
    });
    expect(applied).toEqual([{ email: host.email, updates: [{ type: 'addParty', party: expect.objectContaining({ slug: node.code, isHost: true }) }] }]);
  });
});

describe('party lists saved before summaries existed', () => {
  it('fills in missing summaries once, from the parties, and stores them', async () => {
    const me = await person('Me');
    const { node } = (await gql(env, CREATE, { name: 'Old row' }, me.token)).data.parties.createParty;
    await runInDurableObject(env.USER.getByName(me.email), async (_i, state) => {
      state.storage.sql.exec('UPDATE parties SET is_host = NULL, is_protected = NULL, is_closed = NULL');
    });

    const first = countingEnv();
    const list = await gql(first.env, `{ parties { code name isHost isClosed } }`, {}, me.token);
    expect(list.data.parties).toEqual([{ code: node.code, name: 'Old row', isHost: true, isClosed: false }]);
    expect(first.calls.map(c => `${c.binding}.${c.method}`).sort()).toEqual(['PARTY.view', 'USER.apply', 'USER.listParties']);

    const second = countingEnv();
    await gql(second.env, `{ parties { code isHost } }`, {}, me.token);
    expect(second.calls.map(c => `${c.binding}.${c.method}`)).toEqual(['USER.listParties']);
  });

  it('skips parties that no longer exist while filling in', async () => {
    const me = await person('Me');
    await env.USER.getByName(me.email).apply([{ type: 'addParty', party: { slug: 'QQQQZ', name: 'Gone', createdAt: 1, isHost: false, isProtected: false, isClosed: false } }]);
    await runInDurableObject(env.USER.getByName(me.email), async (_i, state) => {
      state.storage.sql.exec('UPDATE parties SET is_host = NULL');
    });
    expect((await gql(env, `{ parties { code } }`, {}, me.token)).data.parties).toEqual([]);
  });

  it('adds the summary columns to an existing list', async () => {
    const email = `eff-migrate-${++counter}@example.com`;
    const stub = env.USER.getByName(email);
    await stub.ensure(email);
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec('DROP TABLE parties');
      state.storage.sql.exec('CREATE TABLE parties (slug TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)');
      state.storage.sql.exec("INSERT INTO parties VALUES ('QQQQY', 'Before', 5)");
    });
    await evictDurableObject(stub);
    expect(await env.USER.getByName(email).listParties(10)).toEqual([
      { slug: 'QQQQY', name: 'Before', createdAt: 5, isHost: null, isProtected: null, isClosed: null },
    ]);
  });
});
