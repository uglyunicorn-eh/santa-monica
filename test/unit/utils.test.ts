import { env } from 'cloudflare:test';
import * as jose from 'jose';
import { describe, expect, it } from 'vitest';

import { isPermanentMailError, render } from 'src/mail';
import { rateLimitKey } from 'src/utils/ip';
import { createJwtHelpers, isExpiredToken } from 'src/utils/jwt';
import { strToNodeId } from 'src/utils/strings/nodeId';
import { randomInt, randomString } from 'src/utils/strings/random';

describe('jwt', () => {
  const helpers = createJwtHelpers({ privateKey: env.JWT_PRIVATE_KEY, issuer: 'api.test' });

  it('issues tokens without an expiry when no ttl is given', async () => {
    const token = await helpers.issueToken('EnterRequest', {});
    const payload = await helpers.jwtVerify<{ exp?: number; iss?: string }>(token, 'EnterRequest');
    expect(payload.exp).toBeUndefined();
    expect(payload.iss).toBe('api.test');
  });

  it('refuses a token of the wrong type', async () => {
    const token = await helpers.issueToken('UserToken', {}, { ttl: 60 });
    await expect(helpers.jwtVerify(token, 'EnterRequest')).rejects.toThrow('Expected a EnterRequest token.');
  });

  it('opens tokens made with the previous key while it is rotated out, and makes new ones with the current key', async () => {
    const old = await createJwtHelpers({ privateKey: env.TEST_OTHER_PRIVATE_KEY, issuer: 'api.test' }).issueToken('UserToken', { n: 1 }, { ttl: 60 });
    await expect(helpers.jwtVerify(old, 'UserToken')).rejects.toBeInstanceOf(jose.errors.JWEDecryptionFailed);
    const rotating = createJwtHelpers({ privateKey: env.JWT_PRIVATE_KEY, previousKey: env.TEST_OTHER_PRIVATE_KEY, issuer: 'api.test' });
    expect(await rotating.jwtVerify(old, 'UserToken')).toMatchObject({ n: 1 });
    await expect(rotating.jwtVerify(old, 'EnterRequest')).rejects.toThrow('Expected a EnterRequest token.');
    const fresh = await rotating.issueToken('UserToken', { n: 2 }, { ttl: 60 });
    expect(await helpers.jwtVerify(fresh, 'UserToken')).toMatchObject({ n: 2 });
    // Anything else wrong with a token isn't retried with the previous key.
    await expect(rotating.jwtVerify('not.a.token.at.all', 'UserToken')).rejects.not.toBeInstanceOf(jose.errors.JWEDecryptionFailed);
  });

  it('refuses a token from another issuer', async () => {
    const other = createJwtHelpers({ privateKey: env.JWT_PRIVATE_KEY, issuer: 'elsewhere' });
    const token = await other.issueToken('UserToken', {}, { ttl: 60 });
    await expect(helpers.jwtVerify(token, 'UserToken')).rejects.toThrow();
  });

  it('refuses a token signed with another key', async () => {
    const other = createJwtHelpers({ privateKey: env.TEST_OTHER_PRIVATE_KEY, issuer: 'api.test' });
    const token = await other.issueToken('UserToken', {}, { ttl: 60 });
    await expect(helpers.jwtVerify(token, 'UserToken')).rejects.toThrow();
  });

  it('issues encrypted tokens (dir, A256GCM) that nothing outside the Worker can read', async () => {
    const token = await helpers.issueToken('EnterRequest', { email: 'a@example.com', party: 'QWERTYUI' }, { ttl: 60 });
    expect(token.split('.')).toHaveLength(5);
    expect(jose.decodeProtectedHeader(token)).toMatchObject({ alg: 'dir', enc: 'A256GCM', t: 'EnterRequest' });
    // Not a JWS: there is no readable payload in it.
    expect(() => jose.decodeJwt(token)).toThrow();
    const readable = token.split('.').map(part => { try { return atob(part.replace(/-/g, '+').replace(/_/g, '/')); } catch { return ''; } }).join('');
    expect(readable).not.toContain('example.com');
    expect(readable).not.toContain('QWERTYUI');
  });

  it('refuses a token with a changed byte', async () => {
    const token = await helpers.issueToken('UserToken', { sub: 'x' }, { ttl: 60 });
    const parts = token.split('.');
    parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
    await expect(helpers.jwtVerify(parts.join('.'), 'UserToken')).rejects.toThrow();
  });

  it('refuses an expired token as expired, unless asked to accept it for a while', async () => {
    const token = await helpers.issueToken('EnterRequest', { email: 'a@example.com' }, { ttl: -60 });
    const error = await helpers.jwtVerify(token, 'EnterRequest').catch(e => e);
    expect(isExpiredToken(error)).toBe(true);
    expect(isExpiredToken(new Error('other'))).toBe(false);
    expect(await helpers.jwtVerify(token, 'EnterRequest', { expiredFor: 3600 })).toMatchObject({ email: 'a@example.com' });
    await expect(helpers.jwtVerify(token, 'EnterRequest', { expiredFor: 10 })).rejects.toThrow();
  });

  it('derives the same key from a secret stored on one line with escaped line breaks', async () => {
    const escaped = createJwtHelpers({ privateKey: env.JWT_PRIVATE_KEY.trim().split('\n').join('\\n'), issuer: 'api.test' });
    const token = await escaped.issueToken('UserToken', { sub: 'x' }, { ttl: 60 });
    expect(await helpers.jwtVerify(token, 'UserToken')).toMatchObject({ sub: 'x' });
  });

  it('fails clearly without a secret, and does not cache the failure', async () => {
    const broken = createJwtHelpers({ privateKey: '  ', issuer: 'api.test' });
    await expect(broken.issueToken('UserToken', {})).rejects.toThrow('JWT_PRIVATE_KEY is not set.');
    await expect(broken.issueToken('UserToken', {})).rejects.toThrow('JWT_PRIVATE_KEY is not set.');
  });
});

describe('node ids', () => {
  it('needs a kind, a colon and an id', () => {
    for (const s of [btoa('Party'), btoa(':QWERT'), btoa('Party:'), '%%%']) {
      expect(() => strToNodeId(s)).toThrow('is not a valid Node ID');
    }
  });

  it('keeps colons inside the id', () => {
    expect(strToNodeId(btoa('Kind:a:b'))).toEqual({ kind: 'Kind', id: 'a:b' });
  });
});

describe('random strings', () => {
  it('uses letters and digits by default', () => {
    expect(randomString(64)).toMatch(/^[A-Za-z0-9]{64}$/);
  });

  it('draws from the given alphabet', () => {
    expect(randomString(20, 'AB')).toMatch(/^[AB]{20}$/);
  });

  it('stays in range for awkward sizes', () => {
    for (const max of [1, 3, 26, 1000, 0x7fffffff]) {
      for (let i = 0; i < 50; i++) {
        const n = randomInt(max);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThan(max);
      }
    }
  });
});

describe('mail', () => {
  it('leaves unknown placeholders untouched', () => {
    const message = render({ subject: '{{a}} {{b}}', html: '<p>{{a}} {{b}}</p>', text: '{{a}} {{b}}' }, { a: '<A>' });
    expect(message).toEqual({ subject: '<A> {{b}}', html: '<p>&lt;A&gt; {{b}}</p>', text: '<A> {{b}}' });
  });

  it('escapes every HTML special character', () => {
    expect(render({ subject: '', html: '{{v}}', text: '' }, { v: `&<>"'` }).html).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('knows which errors are worth retrying', () => {
    for (const code of ['E_RECIPIENT_SUPPRESSED', 'E_VALIDATION_ERROR', 'E_FIELD_MISSING']) {
      expect(isPermanentMailError(Object.assign(new Error(code), { code }))).toBe(true);
    }
    for (const error of [
      Object.assign(new Error(), { code: 'E_RATE_LIMIT_EXCEEDED' }),
      Object.assign(new Error(), { code: 'E_SENDER_NOT_VERIFIED' }),
      new Error('no code'),
      null,
      undefined,
    ]) {
      expect(isPermanentMailError(error)).toBe(false);
    }
  });
});

describe('rateLimitKey', () => {
  it('keeps IPv4 addresses, and anything that is not IPv6, as they are', () => {
    expect(rateLimitKey('192.0.2.7')).toBe('192.0.2.7');
    expect(rateLimitKey('unknown')).toBe('unknown');
  });

  it('counts an IPv4-mapped IPv6 address as its IPv4 address', () => {
    expect(rateLimitKey('::ffff:192.0.2.7')).toBe('192.0.2.7');
    expect(rateLimitKey('::FFFF:192.0.2.7')).toBe('192.0.2.7');
  });

  it('counts IPv6 per /64, however the address is written', () => {
    const key = '2001:db8:85a3:12::/64';
    expect(rateLimitKey('2001:0db8:85a3:0012:0000:8a2e:0370:7334')).toBe(key);
    expect(rateLimitKey('2001:DB8:85A3:12::1')).toBe(key);
    expect(rateLimitKey('2001:db8:85a3:12:ffff::')).toBe(key);
    expect(rateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitKey('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitKey('::')).toBe('0:0:0:0::/64');
  });

  it('keeps malformed addresses as they are', () => {
    for (const ip of ['1::2::3', '1:2:3', '1:2:3:4:5:6:7:8:9', '1:2:3:4::5:6:7:8', 'g::1', '12345::1']) {
      expect([ip, rateLimitKey(ip)]).toEqual([ip, ip]);
    }
  });
});
