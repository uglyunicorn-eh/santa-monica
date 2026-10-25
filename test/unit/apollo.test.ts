import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import * as yup from 'yup';

import { ApolloContext, authenticate, makeContext, requireUser } from 'src/apollo/context';
import mutations from 'src/apollo/mutations';
import resolvers from 'src/apollo/resolvers';
import { partyViewToNode } from 'src/apollo/resolvers/party';
import { PartyDO } from 'src/do/PartyDO';
import { EnterRequestToken, UserToken } from 'src/apollo/types';
import { MailMessage } from 'src/mail';
import resolvable from 'src/utils/graphql/resolvable';
import { createJwtHelpers } from 'src/utils/jwt';
import { nodeIdToStr } from 'src/utils/strings/nodeId';

import { domain } from 'src/config.json';

let counter = 0;
const uniqueEmail = (label = 'user') => `${label}-${Date.now().toString(36)}-${++counter}@example.com`;
const jwt = createJwtHelpers({ privateKey: env.JWT_PRIVATE_KEY, issuer: domain });

type TestContext = ApolloContext & { sent: { to: string; message: MailMessage }[] };

function context(overrides: Partial<ApolloContext> = {}): TestContext {
  const sent: TestContext['sent'] = [];
  return {
    env,
    clientIp: `192.0.2.${++counter % 250}`,
    retrieveUser: async () => null,
    sendMail: async (to, message) => { sent.push({ to, message }); },
    ...jwt,
    sent,
    ...overrides,
  };
}

async function signedIn(name = 'Person', overrides: Partial<ApolloContext> = {}) {
  const email = uniqueEmail();
  const user = await env.USER.getByName(email).ensure(email);
  await env.USER.getByName(email).apply([{ type: 'setName', name }]);
  return context({
    userId: user.id,
    userEmail: email,
    retrieveUser: async () => await env.USER.getByName(email).get(),
    ...overrides,
  });
}

const { auth, parties } = mutations.Mutation;
const { party, parties: listParties, user, app } = resolvers.Query;

const createParty = async (ctx: ApolloContext, name = 'Party', password?: string) =>
  await parties(null, {}, ctx).createParty({ input: { name, password } }, ctx) as any;

describe('auth mutations', () => {
  it('sends a magic link for a valid email', async () => {
    const ctx = context();
    const email = uniqueEmail();
    expect(await auth().enterRequest({ input: { email: email.toUpperCase(), party: undefined as any } }, ctx)).toEqual({ status: 'ok', userErrors: null });
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].to).toBe(email);
    expect(ctx.sent[0].message.text).toMatch(/https:\/\/gnomik\.me\/enter\//);
  });

  it('puts a valid party code into the magic link', async () => {
    const host = await signedIn('Host');
    const created = await createParty(host);
    const ctx = context();
    await auth().enterRequest({ input: { email: uniqueEmail(), party: created.node.code } }, ctx);
    const token = /enter\/(\S+)/.exec(ctx.sent[0].message.text)![1].replace(/[^\w.-].*$/, '');
    expect(await jwt.jwtVerify(token, 'EnterRequest')).toMatchObject({ party: created.node.code });
  });

  it('rejects an unknown party code', async () => {
    const ctx = context();
    expect(await auth().enterRequest({ input: { email: uniqueEmail(), party: 'QQQQQ' } }, ctx)).toMatchObject({
      status: 'error', userErrors: [{ fieldName: 'party', messages: ['Invalid party code.'] }],
    });
    expect(ctx.sent).toHaveLength(0);
  });

  it('stops when either rate limit is hit', async () => {
    const denied = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    const allowed = { limit: async () => ({ success: true }) } as unknown as RateLimit;
    for (const limits of [{ ENTER_RATE_LIMIT_IP: denied }, { ENTER_RATE_LIMIT_EMAIL: denied }]) {
      const ctx = context({ env: { ...env, ENTER_RATE_LIMIT_IP: allowed, ENTER_RATE_LIMIT_EMAIL: allowed, ...limits } });
      expect(await auth().enterRequest({ input: { email: uniqueEmail(), party: undefined as any } }, ctx)).toMatchObject({
        status: 'error', userErrors: [{ fieldName: 'email' }],
      });
      expect(ctx.sent).toHaveLength(0);
    }
  });

  it('reports a failed send', async () => {
    const ctx = context({ sendMail: async () => { throw new Error('down'); } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await auth().enterRequest({ input: { email: uniqueEmail(), party: undefined as any } }, ctx)).toMatchObject({
      status: 'error', userErrors: [{ fieldName: 'email' }],
    });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('signs in with a magic-link token and rejects anything else', async () => {
    const email = uniqueEmail();
    const token = await jwt.issueToken<EnterRequestToken>('EnterRequest', { email: email.toUpperCase(), jti: crypto.randomUUID() }, { ttl: 60 });
    const entered = await auth().enter({ input: { enterRequestToken: token } }, context()) as any;
    expect(entered).toMatchObject({ status: 'ok', user: { name: '' } });
    expect(await jwt.jwtVerify<UserToken>(entered.userToken, 'UserToken')).toMatchObject({ sub: entered.user.id, email });

    expect(await auth().enter({ input: { enterRequestToken: entered.userToken } }, context())).toMatchObject({
      status: 'error', userErrors: [{ fieldName: 'enterRequestToken', messages: ['Invalid request token.'] }],
    });
  });

  it('puts a fresh id in every magic link', async () => {
    const ctx = context();
    const email = uniqueEmail();
    await auth().enterRequest({ input: { email, party: undefined as any } }, ctx);
    await auth().enterRequest({ input: { email, party: undefined as any } }, ctx);
    const ids = await Promise.all(ctx.sent.map(async ({ message }) => {
      const token = /enter\/([\w-]+\.[\w-]+\.[\w-]+)/.exec(message.text)![1];
      return (await jwt.jwtVerify<EnterRequestToken>(token, 'EnterRequest')).jti;
    }));
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it('lets a magic link be used only once', async () => {
    const token = await jwt.issueToken<EnterRequestToken>('EnterRequest', { email: uniqueEmail(), jti: crypto.randomUUID() }, { ttl: 60 });
    expect(await auth().enter({ input: { enterRequestToken: token } }, context())).toMatchObject({ status: 'ok' });
    expect(await auth().enter({ input: { enterRequestToken: token } }, context())).toEqual({
      status: 'error', userErrors: [{ fieldName: 'enterRequestToken', messages: ['This magic link has already been used. Please request a new one.'] }],
    });
  });

  it('rejects magic-link tokens without an id or an expiry', async () => {
    const invalid = { status: 'error', userErrors: [{ fieldName: 'enterRequestToken', messages: ['Invalid request token.'] }] };
    const withoutId = await jwt.issueToken<EnterRequestToken>('EnterRequest', { email: uniqueEmail() }, { ttl: 60 });
    const withoutExpiry = await jwt.issueToken<EnterRequestToken>('EnterRequest', { email: uniqueEmail(), jti: crypto.randomUUID() });
    expect(await auth().enter({ input: { enterRequestToken: withoutId } }, context())).toMatchObject(invalid);
    expect(await auth().enter({ input: { enterRequestToken: withoutExpiry } }, context())).toMatchObject(invalid);
  });
});

describe('party mutations', () => {
  it('creates a party for the signed-in user, with or without a secret phrase', async () => {
    const host = await signedIn('Host');
    expect(await createParty(host, 'Open')).toMatchObject({ status: 'ok', node: { isHost: true, isProtected: false } });
    expect(await createParty(host, 'Closed', 'pw')).toMatchObject({ status: 'ok', node: { isProtected: true, password: 'pw' } });
  });

  it('needs a user to create a party', async () => {
    // A valid session for an email that has no profile.
    const ctx = context({ userId: 'ghost', userEmail: uniqueEmail() });
    expect(await createParty(ctx)).toMatchObject({ status: 'error', userErrors: [{ fieldName: null }] });
  });

  it('lets one person host up to three open parties', async () => {
    const host = await signedIn('Host');
    const created = [];
    for (let i = 0; i < 3; i++) {
      created.push(await createParty(host, `Party ${i}`));
    }
    expect(created.map(c => c.status)).toEqual(['ok', 'ok', 'ok']);

    expect(await createParty(host, 'One too many')).toEqual({
      status: 'error',
      userErrors: [{ fieldName: null, messages: ['You can host up to 3 open parties at a time. Close or delete one of them to start a new one.'] }],
    });

    // Closing one (it needs a second participant) frees a slot.
    const guest = await signedIn('Guest');
    await parties(null, {}, guest).joinParty({ input: { party: created[0].node.id, name: 'Guest' } }, guest);
    expect((await parties(null, {}, host).closeParty({ input: { party: created[0].node.id } }, host) as any).status).toBe('ok');
    expect((await createParty(host, 'Replacement')).status).toBe('ok');
  });

  it('does not count parties joined as a guest towards the limit', async () => {
    const guest = await signedIn('Guest');
    for (let i = 0; i < 3; i++) {
      const other = await signedIn('Other');
      const { node } = await createParty(other, `Other ${i}`);
      expect((await parties(null, {}, guest).joinParty({ input: { party: node.id, name: 'Guest' } }, guest) as any).status).toBe('ok');
    }
    expect((await createParty(guest, 'Mine')).status).toBe('ok');
  });

  describe('deleting and restoring a party', () => {
    const del = async (ctx: ApolloContext, id: string) =>
      await parties(null, {}, ctx).deleteParty({ input: { party: id } }, ctx) as any;
    const restore = async (ctx: ApolloContext, id: string) =>
      await parties(null, {}, ctx).restoreParty({ input: { party: id } }, ctx) as any;
    const join = async (ctx: ApolloContext, id: string) =>
      await parties(null, {}, ctx).joinParty({ input: { party: id, name: 'Guest' } }, ctx) as any;
    const codes = async (ctx: ApolloContext) => (await listParties(null, { first: 10 }, ctx))!.map((p: any) => p.code);
    const DAY = 24 * 60 * 60 * 1000;
    /**
     * Waits until every queued list update for the party has been delivered (other members' lists update on its
     * alarm), running the alarm now rather than racing the real one.
     */
    const settle = (code: string) => vi.waitFor(async () => {
      const stub = env.PARTY.getByName(code);
      await runDurableObjectAlarm(stub);
      expect(await runInDurableObject(stub, async (_i, state) =>
        state.storage.sql.exec(`SELECT COUNT(*) AS n FROM outbox WHERE payload LIKE '%"user.%'`).one().n)).toBe(0);
    });
    /** Moves the deletion back in time, as if it happened `ms` ago. */
    const deletedAgo = (code: string, ms: number) => runInDurableObject(env.PARTY.getByName(code), async (_i, state) => {
      state.storage.sql.exec('UPDATE party SET deleted_at = ?', Date.now() - ms);
    });

    it('hides a deleted party from everyone but the host, who sees when it can be restored until', async () => {
      const host = await signedIn('Host');
      const guest = await signedIn('Guest');
      const stranger = await signedIn('Stranger');
      const { node } = await createParty(host, 'Gone soon');
      await join(guest, node.id);

      const before = Date.now();
      const deleted = await del(host, node.id);
      await settle(node.code);
      expect(deleted).toMatchObject({ status: 'ok', node: { code: node.code, isHost: true } });
      const deletedAt = Date.parse(deleted.node.deletedAt);
      expect(deletedAt).toBeGreaterThanOrEqual(before);
      expect(Date.parse(deleted.node.restorableUntil)).toBe(deletedAt + DAY);

      expect(await party(null, { code: node.code }, guest)).toBeNull();
      expect(await party(null, { code: node.code }, stranger)).toBeNull();
      expect((await party(null, { code: node.code }, host) as any).deletedAt).toBe(deleted.node.deletedAt);
      expect(await codes(guest)).toEqual([]);
      expect((await listParties(null, { first: 10 }, host))!).toMatchObject([{ code: node.code, deletedAt: deleted.node.deletedAt }]);

      const gone = { status: 'error', userErrors: [{ fieldName: 'party', messages: ['Party does not exist.'] }] };
      expect(await join(stranger, node.id)).toMatchObject(gone);
      expect(await parties(null, {}, guest).leaveParty({ input: { party: node.id } }, guest)).toMatchObject(gone);
      expect(await parties(null, {}, host).closeParty({ input: { party: node.id } }, host)).toMatchObject(gone);
      expect(await del(host, node.id)).toMatchObject(gone);
    });

    it('restores the party for everyone, exactly as it was', async () => {
      const host = await signedIn('Host');
      const guest = await signedIn('Guest');
      const { node } = await createParty(host, 'Back again');
      await join(guest, node.id);
      await parties(null, {}, host).closeParty({ input: { party: node.id } }, host);
      const target = (await party(null, { code: node.code }, guest) as any).target;

      await del(host, node.id);
      await settle(node.code);
      expect(await restore(host, node.id)).toMatchObject({ status: 'ok', node: { code: node.code, deletedAt: null, restorableUntil: null, isClosed: true } });
      await settle(node.code);
      expect(await party(null, { code: node.code }, guest)).toMatchObject({ isJoined: true, isClosed: true, target });
      expect(await codes(guest)).toEqual([node.code]);
      expect(await restore(host, node.id)).toMatchObject({ status: 'error', userErrors: [{ messages: ['There is no deleted party to restore.'] }] });
    });

    it('is only for the host', async () => {
      const host = await signedIn('Host');
      const guest = await signedIn('Guest');
      const { node } = await createParty(host, 'Mine');
      await join(guest, node.id);
      expect(await del(guest, node.id)).toMatchObject({ status: 'error', userErrors: [{ messages: ['You must be the host to delete the party.'] }] });
      await del(host, node.id);
      expect(await restore(guest, node.id)).toMatchObject({ status: 'error', userErrors: [{ messages: ['There is no deleted party to restore.'] }] });
    });

    it('frees the slot, and restoring an open party needs one again (a closed party does not)', async () => {
      const host = await signedIn('Host');
      const guest = await signedIn('Guest');
      const open = [];
      for (let i = 0; i < 3; i++) {
        open.push((await createParty(host, `Party ${i}`)).node);
      }
      await del(host, open[0].id);
      const replacement = (await createParty(host, 'Replacement')).node;
      expect(replacement).toBeTruthy();
      expect(await restore(host, open[0].id)).toEqual({
        status: 'error',
        userErrors: [{ fieldName: null, messages: ['You can host up to 3 open parties at a time. Close or delete one of them to restore this one.'] }],
      });

      // Close one (with a guest), delete and restore it while at the limit: closed parties don't count.
      await join(guest, open[1].id);
      await parties(null, {}, host).closeParty({ input: { party: open[1].id } }, host);
      await createParty(host, 'Fills the freed slot');
      await del(host, open[1].id);
      expect((await restore(host, open[1].id)).status).toBe('ok');
    });

    it('cannot be restored after a day, and the alarm then erases it for good', async () => {
      const host = await signedIn('Host');
      const { node } = await createParty(host, 'Too late');
      await del(host, node.id);
      await settle(node.code);
      await deletedAgo(node.code, DAY + 1000);

      expect(await restore(host, node.id)).toMatchObject({ status: 'error', userErrors: [{ messages: ['This party was deleted more than a day ago and can no longer be restored.'] }] });
      expect(await party(null, { code: node.code }, host)).toBeNull();

      await runInDurableObject(env.PARTY.getByName(node.code), async (instance: PartyDO) => { await instance.alarm(); });
      expect(await codes(host)).toEqual([]);
      expect(await env.PARTY.getByName(node.code).create({
        id: 'x', slug: node.code, name: 'Twice', password: null, host: { id: 'h', email: null, name: 'H' },
      })).toEqual({ ok: false, conflict: true });
    });

    it('schedules the erase for when the restore window ends, and leaves a party within it alone', async () => {
      const host = await signedIn('Host');
      const { node } = await createParty(host, 'Scheduled');
      const { deletedAt } = (await del(host, node.id)).node;
      await settle(node.code); // runs early: nothing is due, so it only reschedules
      await vi.waitFor(() => runInDurableObject(env.PARTY.getByName(node.code), async (_i, state) => {
        expect(await state.storage.getAlarm()).toBe(Date.parse(deletedAt) + DAY);
      }));
      expect((await party(null, { code: node.code }, host) as any).deletedAt).toBe(deletedAt);
    });

    it('erases parties made before tombstones or whose host had left', async () => {
      const host = await signedIn('Host');
      const { node } = await createParty(host, 'Old one');
      await del(host, node.id);
      await settle(node.code);
      await deletedAgo(node.code, DAY + 1000);
      await runInDurableObject(env.PARTY.getByName(node.code), async (instance: PartyDO, state) => {
        state.storage.sql.exec('DROP TABLE cancelled');
        state.storage.sql.exec('DELETE FROM memberships');
        await instance.alarm();
        expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM party').one().n).toBe(0);
      });
    });

    it('adds the deleted_at column to parties made before deletion existed', async () => {
      const host = await signedIn('Host');
      // A party stored with the old schema, in an object that has not looked at its tables yet.
      await runInDurableObject(env.PARTY.getByName('OLDPA'), async (_i, state) => {
        state.storage.sql.exec(`
          CREATE TABLE party (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, password TEXT, host_id TEXT NOT NULL, is_closed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
          CREATE TABLE memberships (member_id TEXT PRIMARY KEY, member_email TEXT, name TEXT NOT NULL, target_id TEXT, target_name TEXT, joined_at INTEGER NOT NULL);
          CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL);
        `);
        state.storage.sql.exec("INSERT INTO party VALUES ('p', 'OLDPA', 'Old schema', NULL, ?, 0, 1)", host.userId);
        // A member imported without an email gets no list update.
        state.storage.sql.exec("INSERT INTO memberships VALUES (?, ?, 'Host', NULL, NULL, 1), ('m', NULL, 'No email', NULL, NULL, 2)", host.userId, host.userEmail);
      });
      const id = nodeIdToStr({ kind: 'Party', id: 'OLDPA' });
      expect(await del(host, id)).toMatchObject({ status: 'ok', node: { code: 'OLDPA', deletedAt: expect.any(String) } });
      expect((await restore(host, id)).status).toBe('ok');
    });

    it('fills in an old list row for a deleted party, keeping it marked deleted', async () => {
      const host = await signedIn('Host');
      const { node } = await createParty(host, 'Stale row');
      const { deletedAt } = (await del(host, node.id)).node;
      await runInDurableObject(env.USER.getByName(host.userEmail!), async (_i, state) => {
        state.storage.sql.exec('UPDATE parties SET is_host = NULL, deleted_at = NULL');
      });
      expect(await listParties(null, { first: 10 }, host)).toMatchObject([{ code: node.code, deletedAt }]);
      expect(await env.USER.getByName(host.userEmail!).listParties(10)).toMatchObject([{ slug: node.code, deletedAt: Date.parse(deletedAt) }]);
    });

    it('does nothing on an alarm for a code that was never used', async () => {
      await runInDurableObject(env.PARTY.getByName('ZZZZZ'), async (instance: PartyDO, state) => {
        await instance.alarm();
        expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'party'").one().n).toBe(0);
      });
    });

    it('does not let the host leave their own party (they delete it instead)', async () => {
      const host = await signedIn('Host');
      const { node } = await createParty(host, 'Mine');
      expect(await parties(null, {}, host).leaveParty({ input: { party: node.id } }, host)).toMatchObject({
        status: 'error',
        userErrors: [{ fieldName: 'party', messages: ["As the host, you can't leave your own party. Delete it instead, or close it once others have joined."] }],
      });
      expect(await codes(host)).toEqual([node.code]);
    });

    it('rejects ids that are not parties', async () => {
      const host = await signedIn('Host');
      for (const action of [del, restore]) {
        expect(await action(host, nodeIdToStr({ kind: 'User', id: 'x' }))).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'party' }] });
        expect(await action(host, '')).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'party' }] });
      }
    });
  });

  it('retries on a code collision, and gives up after ten', async () => {
    const host = await signedIn('Host');
    let calls = 0;
    const collideOnce = {
      ...env,
      PARTY: { getByName: (slug: string) => (++calls === 1 ? { create: async () => ({ ok: false, conflict: true }) } : env.PARTY.getByName(slug)) },
    } as typeof env;
    expect(await createParty({ ...host, env: collideOnce })).toMatchObject({ status: 'ok' });
    expect(calls).toBe(2);

    const alwaysCollide = { ...env, PARTY: { getByName: () => ({ create: async () => ({ ok: false, conflict: true }) }) } } as unknown as typeof env;
    await expect(createParty({ ...host, env: alwaysCollide })).rejects.toThrow('Unable to generate a unique party code.');
  });

  it('joins, leaves and closes through party node ids', async () => {
    const host = await signedIn('Host');
    const guest = await signedIn('Guest');
    const { node } = await createParty(host, 'P', 'pw');

    expect(await parties(null, {}, guest).joinParty({ input: { party: node.id, name: 'G', password: undefined } }, guest)).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'password' }] });
    expect(await parties(null, {}, guest).joinParty({ input: { party: node.id, name: 'G', password: 'PW' } }, guest)).toMatchObject({ status: 'ok', node: { isJoined: true } });
    expect(await parties(null, {}, guest).leaveParty({ input: { party: node.id } }, guest)).toMatchObject({ status: 'ok', node: { isJoined: false } });
    await parties(null, {}, guest).joinParty({ input: { party: node.id, name: 'G', password: 'pw' } }, guest);
    expect(await parties(null, {}, host).closeParty({ input: { party: node.id } }, host)).toMatchObject({ status: 'ok', node: { isClosed: true, target: { name: 'G' } } });
  });

  it('needs a session for every party mutation', async () => {
    expect(() => parties(null, {}, context())).toThrow('UNAUTHENTICATED');
    expect(() => parties(null, {}, context({ userId: 'a'.repeat(24) }))).toThrow('UNAUTHENTICATED');
    expect(() => requireUser({ ...context(), userId: 'a'.repeat(24), userEmail: 'a@example.com' })).not.toThrow();
  });

  it('joins with the session and the name from the form, without reading the profile', async () => {
    const host = await signedIn('Host');
    const { node } = await createParty(host);
    const guest = await signedIn('Old name', { retrieveUser: async () => { throw new Error('profile should not be read'); } });
    expect(await parties(null, {}, guest).joinParty({ input: { party: node.id, name: 'Form name' } }, guest)).toMatchObject({ status: 'ok', node: { isJoined: true } });
    expect((await env.USER.getByName(guest.userEmail!).get())!.name).toBe('Form name');
  });

  it('rejects ids that are not parties', async () => {
    const ctx = await signedIn();
    const unknown = { status: 'error', userErrors: [{ fieldName: 'party', messages: ['Unknown input type. Must be Party.'] }] };
    for (const id of [nodeIdToStr({ kind: 'User', id: 'x' }), nodeIdToStr({ kind: 'Party', id: 'lower' }), '%%%']) {
      expect(await parties(null, {}, ctx).joinParty({ input: { party: id, name: 'x' } }, ctx)).toMatchObject(unknown);
      expect(await parties(null, {}, ctx).leaveParty({ input: { party: id } }, ctx)).toMatchObject(unknown);
      expect(await parties(null, {}, ctx).closeParty({ input: { party: id } }, ctx)).toMatchObject(unknown);
    }
  });

  it('turns validation failures into user errors', async () => {
    const ctx = await signedIn();
    expect(await createParty(ctx, '')).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'name' }] });
  });
});

describe('queries', () => {
  it('returns the app info', async () => {
    expect(await app()).toEqual({ author: expect.any(String), name: 'santa-monica', version: expect.any(String) });
  });

  it('looks up parties by code, case-insensitively, and ignores malformed codes', async () => {
    const host = await signedIn('Host');
    const { node } = await createParty(host, 'Mine');
    expect(await party(null, { code: node.code.toLowerCase() }, host)).toMatchObject({ code: node.code, isHost: true });
    expect(await party(null, { code: 'nope!' }, host)).toBeNull();
  });

  it('lists my parties, clamping the page size', async () => {
    const host = await signedIn('Host');
    await createParty(host, 'A');
    await createParty(host, 'B');
    expect((await listParties(null, { first: 25 }, host))!.map((p: any) => p.name)).toEqual(['B', 'A']);
    expect(await listParties(null, { first: 1000 }, host)).toHaveLength(2);
    expect(await listParties(null, { first: -5 }, host)).toEqual([]);
    expect(await listParties(null, { first: 25 }, context())).toBeNull();
  });

  it('returns the signed-in user, or null', async () => {
    const ctx = await signedIn('Me');
    expect(await user(null, {}, ctx)).toMatchObject({ id: nodeIdToStr({ kind: 'User', id: ctx.userId! }), name: 'Me' });
    expect(await user(null, {}, context({ retrieveUser: async () => null }))).toBeNull();
  });

  it('maps a party view to a node, with and without a target', () => {
    expect(partyViewToNode(null)).toBeNull();
    const view = {
      id: 'x', slug: 'QWERT', name: 'P', password: null, isProtected: false, isHost: false, isJoined: true,
      isClosed: true, deletedAt: null, participantCount: 2, participants: ['A'], target: { id: 'a'.repeat(24), name: 'A' },
    };
    expect(partyViewToNode(view)).toMatchObject({ id: nodeIdToStr({ kind: 'Party', id: 'QWERT' }), target: { id: nodeIdToStr({ kind: 'User', id: 'a'.repeat(24) }), name: 'A' } });
    expect(partyViewToNode({ ...view, target: null })!.target).toBeNull();
  });
});

describe('request auth', () => {
  it('accepts a valid session token', async () => {
    const email = uniqueEmail();
    const stored = await env.USER.getByName(email).ensure(email);
    const token = await jwt.issueToken<UserToken>('UserToken', { sub: nodeIdToStr({ kind: 'User', id: stored.id }), email }, { ttl: 60 });
    expect(await authenticate(token, jwt.jwtVerify)).toEqual({ userId: stored.id, userEmail: email });
  });

  it('treats missing and invalid tokens as anonymous', async () => {
    const email = uniqueEmail();
    const tokens = [
      undefined,
      'garbage',
      await jwt.issueToken<UserToken>('UserToken', { sub: nodeIdToStr({ kind: 'Party', id: 'QWERT' }), email }, { ttl: 60 }),
      await jwt.issueToken('UserToken', { sub: nodeIdToStr({ kind: 'User', id: 'a'.repeat(24) }) }, { ttl: 60 }),
      await jwt.issueToken<EnterRequestToken>('EnterRequest', { email }, { ttl: 60 }),
    ];
    for (const token of tokens) {
      expect(await authenticate(token, jwt.jwtVerify)).toEqual({});
    }
  });
});

describe('resolvable', () => {
  const schema = yup.object({ name: yup.string().trim().required() });
  const handler = resolvable(schema, 'test')(async (input: { name: string }) => ({ node: { id: input.name } }));

  it('passes cast input to the handler', async () => {
    expect(await handler({ input: { name: '  x  ' } }, context())).toEqual({ status: 'ok', userErrors: null, node: { id: 'x' } });
  });

  it('returns validation errors as user errors', async () => {
    expect(await handler({ input: { name: '' } }, context())).toEqual({ status: 'error', userErrors: [{ fieldName: 'name', messages: ['name is a required field'] }] });
  });
});

describe('request context', () => {
  const honoContext = (headers: Record<string, string>) => ({
    env,
    req: { header: (name: string) => headers[name] },
  }) as any;

  it('reads the client IP, and treats an invalid bearer token as anonymous', async () => {
    const ctx = await makeContext(honoContext({ 'cf-connecting-ip': '203.0.113.1', authorization: 'Bearer abc' }));
    expect(ctx).toMatchObject({ clientIp: '203.0.113.1', userId: undefined, userEmail: undefined });
    expect(await ctx.retrieveUser()).toBeNull();
  });

  it('verifies the session once, when the request comes in', async () => {
    const email = uniqueEmail();
    const stored = await env.USER.getByName(email).ensure(email);
    const token = await jwt.issueToken<UserToken>('UserToken', { sub: nodeIdToStr({ kind: 'User', id: stored.id }), email }, { ttl: 60 });
    const ctx = await makeContext(honoContext({ authorization: `Bearer ${token}` }));
    expect(ctx).toMatchObject({ userId: stored.id, userEmail: email });
    expect(await ctx.retrieveUser()).toMatchObject({ id: stored.id, email });
  });

  it('copes with missing headers', async () => {
    expect(await makeContext(honoContext({}))).toMatchObject({ clientIp: 'unknown', userId: undefined });
  });

  it('sends mail through the EMAIL binding', async () => {
    const send = vi.fn(async () => ({ messageId: 'm' }));
    const ctx = await makeContext({ env: { ...env, EMAIL: { send } }, req: { header: () => undefined } } as any);
    await ctx.sendMail('to@example.com', { subject: 's', html: 'h', text: 't' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'to@example.com', subject: 's', html: 'h', text: 't' }));
  });
});
