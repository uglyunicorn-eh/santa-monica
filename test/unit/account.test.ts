import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { ApolloContext } from 'src/apollo/context';
import mutations from 'src/apollo/mutations';
import { AccountDeletionToken, EmailChangeToken, UserToken } from 'src/apollo/types';
import { PartyDO } from 'src/do/PartyDO';
import { MailMessage } from 'src/mail';
import { newObjectId } from 'src/utils/ids';
import { createJwtHelpers } from 'src/utils/jwt';
import { nodeIdToStr } from 'src/utils/strings/nodeId';

import { domain } from 'src/config.json';

let counter = 0;
const uniqueEmail = (label = 'acct') => `${label}-${Date.now().toString(36)}-${++counter}@example.com`;
const jwt = createJwtHelpers({ privateKey: env.JWT_PRIVATE_KEY, issuer: domain });
const { profile } = mutations.Mutation;

type Sent = { to: string; message: MailMessage }[];
type TestContext = ApolloContext & { sent: Sent };

const allowed = { limit: async () => ({ success: true }) } as unknown as RateLimit;

function context(overrides: Partial<ApolloContext> = {}): TestContext {
  const sent: Sent = [];
  return {
    env: { ...env, ENTER_RATE_LIMIT_IP: allowed, ENTER_RATE_LIMIT_EMAIL: allowed },
    clientIp: '192.0.2.1',
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
    tokenVersion: 0,
    retrieveUser: async () => await env.USER.getByName(email).get(),
    ...overrides,
  });
}

const code = () => {
  const abc = 'QWERTYUIPASDFGHJKLZXCVBNMO';
  let n = ++counter + 5000;
  let s = '';
  for (let i = 0; i < 5; i++) {
    s += abc[n % abc.length];
    n = Math.floor(n / abc.length);
  }
  return s;
};

/** A party whose members are signed-in users (so their lists are kept), optionally drawn. */
async function partyOf(host: TestContext, guests: TestContext[], { closed = false } = {}) {
  const slug = code();
  const stub = env.PARTY.getByName(slug);
  const member = (ctx: TestContext, name: string) => ({ id: ctx.userId!, email: ctx.userEmail!, name });
  await stub.create({ id: newObjectId(), slug, name: `Party ${slug}`, password: null, host: member(host, 'Host') });
  for (const [i, guest] of guests.entries()) {
    await stub.join(member(guest, `Guest ${i}`), `Guest ${i}`, null);
  }
  if (closed) {
    await stub.close(host.userId!);
    await drain(slug);
  }
  return { slug, stub };
}

async function drain(slug: string) {
  const stub = env.PARTY.getByName(slug);
  for (let i = 0; i < 30 && await stub.pendingOutbox(); i++) {
    await runDurableObjectAlarm(stub);
  }
}

const linkToken = (sent: Sent, path: 'delete' | 'email') => {
  const match = new RegExp(`/profile/${path}/([\\w-]+\\.[\\w-]+\\.[\\w-]+)`).exec(sent.at(-1)!.message.text);
  return match![1];
};

const requestDeletion = async (ctx: ApolloContext) => await profile().requestAccountDeletion({ input: undefined as never }, ctx) as any;
const confirmDeletion = async (token: string, ctx: ApolloContext = context()) => await profile().confirmAccountDeletion({ input: { token } }, ctx) as any;
const requestChange = async (ctx: ApolloContext, email: string) => await profile().requestEmailChange({ input: { email } }, ctx) as any;
const confirmChange = async (token: string, ctx: ApolloContext = context()) => await profile().confirmEmailChange({ input: { token } }, ctx) as any;

const slugsOf = async (email: string) => (await env.USER.getByName(email).listParties(50)).map(p => p.slug).sort();

describe('UserDO account changes', () => {
  it('starts a change once per link, only for the same live account, with every party', async () => {
    const email = uniqueEmail();
    const stub = env.USER.getByName(email);
    const user = await stub.ensure(email);
    await stub.apply([{ type: 'addParty', party: { slug: 'QQQEA', name: 'P', createdAt: 1, isHost: true, isProtected: false, isClosed: false } }]);
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec("INSERT INTO parties (slug, name, created_at) VALUES ('QQQEB', 'Old row', 2)");
    });
    const later = Date.now() + 60_000;

    expect(await stub.startAccountChange(newObjectId(), 'j1', later)).toEqual({ ok: false, reason: 'gone' });
    const started = await stub.startAccountChange(user.id, 'j1', later);
    expect(started).toMatchObject({ ok: true, user: { id: user.id } });
    expect((started as any).parties.sort()).toEqual(['QQQEA', 'QQQEB']);
    // Held while the change runs: no second change, no profile, no checked writes.
    expect(await stub.startAccountChange(user.id, 'j2', later)).toEqual({ ok: false, reason: 'busy' });
    expect(await stub.get()).toBeNull();
    expect(await stub.updateName('X', { userId: user.id })).toBeNull();
    expect(await stub.apply([{ type: 'setNameIfEmpty', name: 'Joiner', userId: user.id }], { userId: user.id })).toBeNull();
    expect(await stub.apply([{ type: 'removeParty', slug: 'QQQEB' }])).toMatchObject({ id: user.id });

    // Aborting releases the account and the link, which can be used again.
    await stub.abortAccountChange('j1');
    expect(await stub.get()).toMatchObject({ id: user.id, name: '' });
    expect(await stub.startAccountChange(user.id, 'j1', later)).toMatchObject({ ok: true, parties: ['QQQEA'] });

    // A hold that outlived its request runs out after a minute; a used link stays used.
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec('UPDATE user SET changing_until = ?', Date.now() - 1);
    });
    expect(await stub.get()).toMatchObject({ id: user.id });
    expect(await stub.startAccountChange(user.id, 'j1', later)).toEqual({ ok: false, reason: 'used' });

    await stub.tombstone();
    expect(await stub.startAccountChange(user.id, 'j3', later)).toEqual({ ok: false, reason: 'gone' });
    // A link that was used reads as used, even on the tombstone its change left behind.
    expect(await stub.startAccountChange(user.id, 'j1', later)).toEqual({ ok: false, reason: 'used' });
  });

  it('receives a moved account, refusing an address a live account uses', async () => {
    const taken = uniqueEmail('taken');
    await env.USER.getByName(taken).ensure(taken);
    const record = { id: newObjectId(), email: taken, name: 'Mover', joined: 5, tokenVersion: 1 };
    expect(await env.USER.getByName(taken).receive(record, [])).toBeNull();

    const fresh = uniqueEmail('fresh');
    const stub = env.USER.getByName(fresh);
    // A party already sending to the new address since its membership moved: its row is newer and is kept.
    await stub.apply([{ type: 'addParty', party: { slug: 'QQQFA', name: 'Newer', createdAt: 1, isHost: false, isProtected: false, isClosed: true } }]);
    const moved = await stub.receive({ ...record, email: fresh }, [
      { slug: 'QQQFA', name: 'Older', createdAt: 1, isHost: false, isProtected: false, isClosed: false },
      { slug: 'QQQFB', name: 'Copied', createdAt: 2, isHost: true, isProtected: true, isClosed: false },
    ]);
    expect(moved).toEqual({ id: record.id, email: fresh, name: 'Mover', joined: 5, tokenVersion: 1 });
    expect(await stub.get()).toEqual(moved);
    expect(await stub.listParties(10)).toMatchObject([
      { slug: 'QQQFB', name: 'Copied', isHost: true },
      { slug: 'QQQFA', name: 'Newer', isClosed: true },
    ]);
  });

  it('keeps a tombstone\'s higher token version when receiving over it', async () => {
    const email = uniqueEmail('over');
    const stub = env.USER.getByName(email);
    await stub.ensure(email);
    await stub.tombstone();
    await stub.ensure(email);
    await stub.tombstone();
    expect(await stub.receive({ id: newObjectId(), email, name: '', joined: 1, tokenVersion: 1 }, [])).toMatchObject({ tokenVersion: 2 });
  });
});

describe('PartyDO.forgetMember', () => {
  it('deletes an open party the user hosts, whoever joined: gone at once, off every list, its code retired', async () => {
    const host = await signedIn('Host');
    const guest = await signedIn('Guest');
    const { slug, stub } = await partyOf(host, [guest]);
    await stub.join({ id: newObjectId(), email: null, name: 'Legacy' }, 'Legacy', null);

    expect(await stub.forgetMember(host.userId!, host.userEmail!)).toBe('deleted');
    expect(await stub.view(guest.userId)).toBeNull();
    expect(await stub.join({ id: newObjectId(), email: uniqueEmail(), name: 'Late' }, 'Late', null)).toMatchObject({ ok: false, error: { message: 'Party does not exist.' } });
    expect(await stub.leave(guest.userId!)).toMatchObject({ ok: false });
    expect(await stub.forgetMember(guest.userId!, guest.userEmail!)).toBe('none');

    await drain(slug);
    expect(await slugsOf(guest.userEmail!)).toEqual([]);
    expect(await stub.pendingOutbox()).toBe(0);
    // Like a cancelled party, its code is never handed out again.
    expect(await stub.create({ id: newObjectId(), slug, name: 'Reuse', password: null, host: { id: guest.userId!, email: guest.userEmail!, name: 'G' } })).toEqual({ ok: false, conflict: true });
  });

  it('deletes parties created before cancelling existed', async () => {
    const host = await signedIn('Host');
    const { stub } = await partyOf(host, []);
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec('DROP TABLE cancelled');
    });
    await evictDurableObject(stub);
    expect(await stub.forgetMember(host.userId!, host.userEmail!)).toBe('deleted');
    expect(await stub.view(host.userId)).toBeNull();
  });

  it('leaves an open party the user joined, and drops what was queued for them', async () => {
    const host = await signedIn('Host');
    const guest = await signedIn('Guest');
    const { slug, stub } = await partyOf(host, [guest]);
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec('INSERT INTO outbox (payload, next_attempt_at) VALUES (?, ?)', JSON.stringify({ kind: 'user.sync', email: guest.userEmail }), Date.now() + 60_000);
    });
    expect(await stub.forgetMember(guest.userId!, guest.userEmail!)).toBe('left');
    expect(await stub.pendingOutbox()).toBe(0);
    expect(await stub.view(host.userId)).toMatchObject({ participantCount: 1, participants: ['Host'] });
    expect(slug).toHaveLength(5);
  });

  it('anonymizes the user in a drawn party: new id everywhere, no email, names kept', async () => {
    const host = await signedIn('Host');
    const guest = await signedIn('Guest');
    const { stub } = await partyOf(host, [guest], { closed: true });
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec('INSERT INTO outbox (payload, next_attempt_at) VALUES (?, ?)', JSON.stringify({ kind: 'mail.partyNotification', email: guest.userEmail, partyName: 'P', slug: 'X' }), Date.now() + 60_000);
    });

    expect(await stub.forgetMember(guest.userId!, guest.userEmail!)).toBe('anonymized');
    expect(await stub.pendingOutbox()).toBe(0);
    expect(await stub.view(guest.userId)).toMatchObject({ isJoined: false, target: null });
    const hostView = (await stub.view(host.userId))!;
    expect(hostView.target!.name).toBe('Guest 0');
    expect(hostView.target!.id).not.toBe(guest.userId);
    await runInDurableObject(stub, async (_i, state) => {
      const rows = state.storage.sql.exec<{ member_id: string; member_email: string | null; name: string; target_id: string; target_name: string }>('SELECT * FROM memberships ORDER BY name').toArray();
      const anonymous = rows.find(r => r.name === 'Guest 0')!;
      expect(anonymous).toMatchObject({ member_email: null, target_name: 'Host' });
      expect(anonymous.member_id).toBe(hostView.target!.id);
      expect(rows.find(r => r.name === 'Host')!.target_id).toBe(anonymous.member_id);
    });

    // The host's own deletion also takes the host role off their old id.
    expect(await stub.forgetMember(host.userId!, host.userEmail!)).toBe('anonymized');
    expect(await stub.view(host.userId)).toMatchObject({ isHost: false, isJoined: false, password: null });
  });

  it('anonymizes the host of a drawn party they had left', async () => {
    const host = await signedIn('Host');
    const a = await signedIn('A');
    const b = await signedIn('B');
    const { stub } = await partyOf(host, [a, b]);
    await stub.leave(host.userId!);
    await stub.close(host.userId!);
    expect(await stub.forgetMember(host.userId!, host.userEmail!)).toBe('anonymized');
    expect(await stub.view(host.userId)).toMatchObject({ isHost: false });
  });

  it('does nothing for strangers and unknown parties', async () => {
    const host = await signedIn('Host');
    const stranger = await signedIn('Stranger');
    const open = await partyOf(host, []);
    const drawn = await partyOf(host, [await signedIn('G')], { closed: true });
    expect(await open.stub.forgetMember(stranger.userId!, stranger.userEmail!)).toBe('none');
    expect(await drawn.stub.forgetMember(stranger.userId!, stranger.userEmail!)).toBe('none');
    expect(await env.PARTY.getByName(code()).forgetMember(stranger.userId!, stranger.userEmail!)).toBe('none');
  });
});

describe('PartyDO.changeMemberEmail', () => {
  it('moves an open party\'s membership and queued updates to the new email', async () => {
    const host = await signedIn('Host');
    const guest = await signedIn('Guest');
    const { stub } = await partyOf(host, [guest]);
    const newEmail = uniqueEmail('moved');
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec('INSERT INTO outbox (payload, next_attempt_at) VALUES (?, ?)', JSON.stringify({ kind: 'user.sync', email: guest.userEmail }), Date.now() + 60_000);
    });
    expect(await stub.changeMemberEmail(guest.userId!, guest.userEmail!, newEmail)).toMatchObject({ isHost: false, isClosed: false });
    await runInDurableObject(stub, async (_i, state) => {
      expect(state.storage.sql.exec('SELECT member_email FROM memberships WHERE member_id = ?', guest.userId).one()).toEqual({ member_email: newEmail });
      expect(JSON.parse(state.storage.sql.exec<{ payload: string }>('SELECT payload FROM outbox').one().payload)).toEqual({ kind: 'user.sync', email: newEmail });
    });
  });

  it('keeps the old email in a drawn party, and returns null for non-members and unknown parties', async () => {
    const host = await signedIn('Host');
    const guest = await signedIn('Guest');
    const { stub } = await partyOf(host, [guest], { closed: true });
    expect(await stub.changeMemberEmail(guest.userId!, guest.userEmail!, uniqueEmail())).toMatchObject({ isClosed: true });
    await runInDurableObject(stub, async (_i, state) => {
      expect(state.storage.sql.exec('SELECT member_email FROM memberships WHERE member_id = ?', guest.userId).one()).toEqual({ member_email: guest.userEmail });
    });
    expect(await stub.changeMemberEmail(newObjectId(), 'x@example.com', 'y@example.com')).toBeNull();
    expect(await env.PARTY.getByName(code()).changeMemberEmail(guest.userId!, 'x@example.com', 'y@example.com')).toBeNull();
  });
});

describe('account deletion mutations', () => {
  it('needs a session to request, but not to confirm', async () => {
    await expect(requestDeletion(context())).rejects.toThrow('UNAUTHENTICATED');
    expect(await confirmDeletion('garbage')).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'token' }] });
  });

  it('emails a single-use link that deletes the account and every trace of it', async () => {
    const me = await signedIn('Me');
    const friend = await signedIn('Friend');
    const mine = await partyOf(me, [friend]);
    const theirs = await partyOf(friend, [me]);
    const drawn = await partyOf(friend, [me], { closed: true });

    expect(await requestDeletion(me)).toEqual({ status: 'ok', userErrors: null });
    expect(me.sent.at(-1)!.to).toBe(me.userEmail);
    const token = linkToken(me.sent, 'delete');
    expect(await jwt.jwtVerify<AccountDeletionToken>(token, 'AccountDeletion')).toMatchObject({ sub: nodeIdToStr({ kind: 'User', id: me.userId! }), email: me.userEmail });

    expect(await confirmDeletion(token)).toEqual({ status: 'ok', userErrors: null });
    expect(await env.USER.getByName(me.userEmail!).get()).toBeNull();
    expect(await mine.stub.view(friend.userId)).toBeNull();
    expect(await theirs.stub.view(friend.userId)).toMatchObject({ participantCount: 1 });
    expect(await drawn.stub.view(me.userId)).toMatchObject({ isJoined: false, target: null });
    await drain(mine.slug);
    expect(await slugsOf(friend.userEmail!)).toEqual([theirs.slug, drawn.slug].sort());

    expect(await confirmDeletion(token)).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'token', messages: ['This link has already been used. Please request a new one.'] }] });
  });

  it('refuses a link while another change runs, and once used', async () => {
    const me = await signedIn('Me');
    const token = await jwt.issueToken<AccountDeletionToken>('AccountDeletion', { sub: nodeIdToStr({ kind: 'User', id: me.userId! }), email: me.userEmail!, jti: 'same' }, { ttl: 60 });
    const stub = env.USER.getByName(me.userEmail!);
    await stub.startAccountChange(me.userId!, 'other', Date.now() + 60_000);
    expect(await confirmDeletion(token)).toMatchObject({ userErrors: [{ messages: ['Another change to this account is in progress. Please try again in a minute.'] }] });
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec('UPDATE user SET changing_until = NULL');
      state.storage.sql.exec("INSERT INTO used_magic_links (jti, expires_at) VALUES ('same', ?)", Date.now() + 60_000);
    });
    expect(await confirmDeletion(token)).toMatchObject({ userErrors: [{ messages: ['This link has already been used. Please request a new one.'] }] });
    expect(await stub.get()).not.toBeNull();
  });

  it('keeps the account when a party can\'t be reached, and finishes when the link is opened again', async () => {
    const me = await signedIn('Me');
    const friend = await signedIn('Friend');
    const theirs = await partyOf(friend, [me]);
    const mine = await partyOf(me, [friend]);
    await requestDeletion(me);
    const token = linkToken(me.sent, 'delete');

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = { ...env, PARTY: { getByName: (slug: string) => (slug === mine.slug ? { forgetMember: async () => { throw new Error('down'); } } : env.PARTY.getByName(slug)) } } as unknown as typeof env;
    expect(await confirmDeletion(token, context({ env: broken }))).toEqual({
      status: 'error', userErrors: [{ fieldName: 'token', messages: ["We couldn't finish this right now. Please open the link again in a few minutes."] }],
    });
    expect(error).toHaveBeenCalledWith('Unable to remove a deleted account from a party', 'Error: down');
    error.mockRestore();
    expect(await env.USER.getByName(me.userEmail!).get()).toMatchObject({ id: me.userId });
    expect(await theirs.stub.view(friend.userId)).toMatchObject({ participantCount: 1 });

    expect(await confirmDeletion(token)).toEqual({ status: 'ok', userErrors: null });
    expect(await env.USER.getByName(me.userEmail!).get()).toBeNull();
    expect(await mine.stub.view(friend.userId)).toBeNull();
  });

  it('rejects links that are expired, of another kind, or missing what identifies the user', async () => {
    const me = await signedIn('Me');
    const sub = nodeIdToStr({ kind: 'User', id: me.userId! });
    const email = me.userEmail!;
    const tokens = [
      await jwt.issueToken<AccountDeletionToken>('AccountDeletion', { sub, email, jti: 'a' }, { ttl: -10 }),
      await jwt.issueToken<AccountDeletionToken>('AccountDeletion', { sub, email, jti: 'a' }),
      await jwt.issueToken('AccountDeletion', { sub, email }, { ttl: 60 }),
      await jwt.issueToken('AccountDeletion', { sub, jti: 'a' }, { ttl: 60 }),
      await jwt.issueToken<AccountDeletionToken>('AccountDeletion', { sub: nodeIdToStr({ kind: 'Party', id: 'QWERT' }), email, jti: 'a' }, { ttl: 60 }),
      await jwt.issueToken<UserToken>('UserToken', { sub, email }, { ttl: 60 }),
    ];
    for (const token of tokens) {
      expect(await confirmDeletion(token)).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'token', messages: ['This link is invalid or has expired. Please request a new one.'] }] });
    }
  });

  it('refuses an expired session, a rate limit, and a failed send', async () => {
    const gone = await signedIn('Gone', { retrieveUser: async () => null });
    expect(await requestDeletion(gone)).toMatchObject({ status: 'error', userErrors: [{ fieldName: null, messages: ['Your session has expired. Please sign in again.'] }] });

    const denied = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    for (const limits of [{ ENTER_RATE_LIMIT_IP: denied }, { ENTER_RATE_LIMIT_EMAIL: denied }]) {
      const me = await signedIn('Me');
      expect(await requestDeletion({ ...me, env: { ...me.env, ...limits } })).toMatchObject({ status: 'error', userErrors: [{ fieldName: null }] });
      expect(me.sent).toHaveLength(0);
    }

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const me = await signedIn('Me', { sendMail: async () => { throw new Error('down'); } });
    expect(await requestDeletion(me)).toMatchObject({ status: 'error', userErrors: [{ fieldName: null, messages: ["We couldn't send the email right now. Please try again in a few minutes."] }] });
    error.mockRestore();
  });
});

describe('email change mutations', () => {
  it('needs a session to request', async () => {
    await expect(requestChange(context(), uniqueEmail())).rejects.toThrow('UNAUTHENTICATED');
  });

  it('emails a link to the new address and a notice to the old one', async () => {
    const me = await signedIn('Me');
    const newEmail = uniqueEmail('new');
    expect(await requestChange(me, newEmail.toUpperCase())).toEqual({ status: 'ok', userErrors: null });
    expect(me.sent.map(s => s.to)).toEqual([newEmail, me.userEmail]);
    expect(me.sent[1].message.text).not.toMatch(/profile\/email/);
    const token = /profile\/email\/(\S+)/.exec(me.sent[0].message.text)![1];
    expect(await jwt.jwtVerify<EmailChangeToken>(token, 'EmailChange')).toMatchObject({ email: me.userEmail, newEmail });
  });

  it('validates the new address', async () => {
    const me = await signedIn('Me');
    const other = uniqueEmail('other');
    await env.USER.getByName(other).ensure(other);
    expect(await requestChange(me, 'not an email')).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'email' }] });
    expect(await requestChange(me, me.userEmail!)).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'email', messages: ["That's already your email."] }] });
    expect(await requestChange(me, other)).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'email', messages: ['This email is already used by another account.'] }] });
    expect(me.sent).toHaveLength(0);
  });

  it('refuses an expired session and a rate limit; reports a failed link but not a failed notice', async () => {
    const gone = await signedIn('Gone', { retrieveUser: async () => null });
    expect(await requestChange(gone, uniqueEmail())).toMatchObject({ userErrors: [{ fieldName: null }] });

    const denied = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    const limited = await signedIn('Me');
    expect(await requestChange({ ...limited, env: { ...limited.env, ENTER_RATE_LIMIT_EMAIL: denied } }, uniqueEmail())).toMatchObject({ status: 'error' });

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const newEmail = uniqueEmail('down');
    const failing = await signedIn('Me', { sendMail: async to => { if (to === newEmail) throw new Error('down'); } });
    expect(await requestChange(failing, newEmail)).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'email' }] });

    const sent: string[] = [];
    const noticeFails = await signedIn('Me', {
      sendMail: async to => { sent.push(to); if (to !== sent[0]) throw new Error('old address down'); },
    });
    expect(await requestChange(noticeFails, uniqueEmail('fine'))).toEqual({ status: 'ok', userErrors: null });
    expect(sent).toHaveLength(2);
    error.mockRestore();
  });

  it('moves the account: open parties follow, drawn ones keep the old email, old tokens stop working', async () => {
    const me = await signedIn('Me');
    const friend = await signedIn('Friend');
    const open = await partyOf(friend, [me]);
    const drawn = await partyOf(friend, [me], { closed: true });
    const newEmail = uniqueEmail('moved');
    await requestChange(me, newEmail);
    const token = /profile\/email\/(\S+)/.exec(me.sent[0].message.text)![1];

    const res = await confirmChange(token);
    expect(res).toMatchObject({ status: 'ok', user: { id: nodeIdToStr({ kind: 'User', id: me.userId! }), name: 'Me', email: newEmail } });
    expect(await jwt.jwtVerify<UserToken>(res.userToken, 'UserToken')).toMatchObject({ email: newEmail, ver: 1 });
    expect(await env.USER.getByName(me.userEmail!).get()).toBeNull();
    expect(await env.USER.getByName(newEmail).get()).toMatchObject({ id: me.userId, name: 'Me', tokenVersion: 1 });
    expect(await slugsOf(newEmail)).toEqual([open.slug, drawn.slug].sort());
    expect(await drawn.stub.view(me.userId)).toMatchObject({ isJoined: true, target: expect.anything() });

    await runInDurableObject(open.stub, async (_i, state) => {
      expect(state.storage.sql.exec('SELECT member_email FROM memberships WHERE member_id = ?', me.userId).one()).toEqual({ member_email: newEmail });
    });
    await runInDurableObject(drawn.stub, async (_i, state) => {
      expect(state.storage.sql.exec('SELECT member_email FROM memberships WHERE member_id = ?', me.userId).one()).toEqual({ member_email: me.userEmail });
    });

    expect(await confirmChange(token)).toMatchObject({ userErrors: [{ fieldName: 'token', messages: ['This link has already been used. Please request a new one.'] }] });
  });

  it('puts the parties back when one can\'t be reached, and finishes when the link is opened again', async () => {
    const me = await signedIn('Me');
    const friend = await signedIn('Friend');
    const a = await partyOf(friend, [me]);
    const b = await partyOf(friend, [me]);
    const newEmail = uniqueEmail('retry');
    await requestChange(me, newEmail);
    const token = /profile\/email\/(\S+)/.exec(me.sent[0].message.text)![1];

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let backCalls = 0;
    const broken = {
      ...env,
      PARTY: {
        getByName: (slug: string) => (slug !== b.slug ? env.PARTY.getByName(slug) : {
          changeMemberEmail: async () => { throw new Error('down'); },
        }),
      },
    } as unknown as typeof env;
    const wrapped = {
      ...broken,
      PARTY: {
        getByName: (slug: string) => {
          const stub = broken.PARTY.getByName(slug);
          return slug !== a.slug ? stub : {
            changeMemberEmail: async (...args: [string, string, string]) => {
              if (args[1] === newEmail) backCalls++;
              return await stub.changeMemberEmail(...args);
            },
          };
        },
      },
    } as unknown as typeof env;
    expect(await confirmChange(token, context({ env: wrapped }))).toMatchObject({ status: 'error', userErrors: [{ fieldName: 'token', messages: ["We couldn't finish this right now. Please open the link again in a few minutes."] }] });
    error.mockRestore();
    expect(backCalls).toBe(1);
    for (const party of [a, b]) {
      await runInDurableObject(party.stub, async (_i, state) => {
        expect(state.storage.sql.exec('SELECT member_email FROM memberships WHERE member_id = ?', me.userId).one()).toEqual({ member_email: me.userEmail });
      });
    }
    expect(await env.USER.getByName(me.userEmail!).get()).toMatchObject({ id: me.userId });
    expect(await env.USER.getByName(newEmail).get()).toBeNull();

    expect(await confirmChange(token)).toMatchObject({ status: 'ok', user: { email: newEmail } });
    expect(await slugsOf(newEmail)).toEqual([a.slug, b.slug].sort());
  });

  it('refuses links that are invalid, used, for a gone account, or for a taken address', async () => {
    const me = await signedIn('Me');
    const sub = nodeIdToStr({ kind: 'User', id: me.userId! });
    const email = me.userEmail!;
    const invalid = ['garbage', await jwt.issueToken('EmailChange', { sub, email, jti: 'x' }, { ttl: 60 })];
    for (const token of invalid) {
      expect(await confirmChange(token)).toMatchObject({ userErrors: [{ fieldName: 'token', messages: ['This link is invalid or has expired. Please request a new one.'] }] });
    }

    const busy = await jwt.issueToken<EmailChangeToken>('EmailChange', { sub, email, newEmail: uniqueEmail(), jti: 'busy' }, { ttl: 60 });
    await env.USER.getByName(email).startAccountChange(me.userId!, 'other', Date.now() + 60_000);
    expect(await confirmChange(busy)).toMatchObject({ userErrors: [{ messages: ['Another change to this account is in progress. Please try again in a minute.'] }] });
    await env.USER.getByName(email).abortAccountChange('other');

    const otherAccount = await jwt.issueToken<EmailChangeToken>('EmailChange', { sub: nodeIdToStr({ kind: 'User', id: newObjectId() }), email, newEmail: uniqueEmail(), jti: 'gone' }, { ttl: 60 });
    expect(await confirmChange(otherAccount)).toMatchObject({ userErrors: [{ messages: ['This account no longer exists.'] }] });

    const takenEmail = uniqueEmail('taken');
    await env.USER.getByName(takenEmail).ensure(takenEmail);
    const taken = await jwt.issueToken<EmailChangeToken>('EmailChange', { sub, email, newEmail: takenEmail, jti: 'taken' }, { ttl: 60 });
    expect(await confirmChange(taken)).toMatchObject({ userErrors: [{ messages: ['This email is already used by another account.'] }] });
    expect(await env.USER.getByName(email).get()).toMatchObject({ id: me.userId });
  });

  it('puts the parties back when the new address is taken during the change', async () => {
    const me = await signedIn('Me');
    const friend = await signedIn('Friend');
    const open = await partyOf(friend, [me]);
    const newEmail = uniqueEmail('raced');
    const token = await jwt.issueToken<EmailChangeToken>('EmailChange', { sub: nodeIdToStr({ kind: 'User', id: me.userId! }), email: me.userEmail!, newEmail, jti: 'race' }, { ttl: 60 });

    // Someone signs up with the new address right after the check.
    let checks = 0;
    const racing = {
      ...env,
      USER: {
        getByName: (name: string) => {
          const stub = env.USER.getByName(name);
          return name !== newEmail ? stub : {
            get: async () => { const user = await stub.get(); if (++checks === 1) await stub.ensure(newEmail); return user; },
            receive: (...args: Parameters<typeof stub.receive>) => stub.receive(...args),
          };
        },
      },
    } as unknown as typeof env;

    expect(await confirmChange(token, context({ env: racing }))).toMatchObject({ userErrors: [{ messages: ['This email is already used by another account.'] }] });
    expect(await env.USER.getByName(me.userEmail!).get()).toMatchObject({ id: me.userId });
    await runInDurableObject(open.stub, async (_i, state) => {
      expect(state.storage.sql.exec('SELECT member_email FROM memberships WHERE member_id = ?', me.userId).one()).toEqual({ member_email: me.userEmail });
    });
  });
});
