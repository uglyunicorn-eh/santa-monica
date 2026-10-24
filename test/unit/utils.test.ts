import { env } from 'cloudflare:test';
import * as jose from 'jose';
import { describe, expect, it } from 'vitest';
import * as yup from 'yup';

import { isPermanentMailError, render } from 'src/mail';
import { createJwtHelpers, pkcs1ToPkcs8 } from 'src/utils/jwt';
import { strToNodeId } from 'src/utils/strings/nodeId';
import { randomInt, randomString } from 'src/utils/strings/random';
import * as YupHelpers from 'src/utils/yup';

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

  it('issues RS256 tokens the frontend can verify with the public key', async () => {
    const frontend = createJwtHelpers({ privateKey: env.JWT_PRIVATE_KEY, issuer: 'api.gnomik.me' });
    const token = await frontend.issueToken('EnterRequest', { email: 'a@example.com' }, { ttl: 60 });
    // This is what the frontend does (src/components/hooks/useJWT.tsx in santa-barbara).
    const publicKey = await jose.importSPKI(env.TEST_PUBLIC_KEY, 'RS256');
    const { payload, protectedHeader } = await jose.jwtVerify(token, publicKey, { issuer: 'api.gnomik.me' });
    expect(protectedHeader.alg).toBe('RS256');
    expect(payload).toMatchObject({ email: 'a@example.com', iss: 'api.gnomik.me' });
  });

  it('accepts PKCS#1 keys and keys with escaped line breaks, like the old Lambda secret', async () => {
    const pkcs1 = createJwtHelpers({ privateKey: env.TEST_PKCS1_PRIVATE_KEY, issuer: 'api.test' });
    const escaped = createJwtHelpers({ privateKey: env.TEST_PKCS1_PRIVATE_KEY.trim().split('\n').join('\\n'), issuer: 'api.test' });
    for (const signer of [pkcs1, escaped]) {
      const token = await signer.issueToken('UserToken', { sub: 'x' }, { ttl: 60 });
      expect(await helpers.jwtVerify(token, 'UserToken')).toMatchObject({ sub: 'x' });
    }
  });

  it('fails clearly on an unusable key, and does not cache the failure', async () => {
    const broken = createJwtHelpers({ privateKey: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----', issuer: 'api.test' });
    await expect(broken.issueToken('UserToken', {})).rejects.toThrow();
    await expect(broken.issueToken('UserToken', {})).rejects.toThrow();
  });

  it('wraps PKCS#1 keys of any size in a PKCS#8 envelope', () => {
    const small = pkcs1ToPkcs8(new Uint8Array(3));
    expect(Array.from(small.slice(0, 2))).toEqual([0x30, small.length - 2]);
    const large = pkcs1ToPkcs8(new Uint8Array(300));
    expect(Array.from(large.slice(0, 4))).toEqual([0x30, 0x82, (large.length - 4) >> 8, (large.length - 4) & 0xff]);
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

describe('input normalisation', () => {
  it('trims and collapses whitespace, and tightens space before punctuation', () => {
    const schema = YupHelpers.string('Name');
    expect(schema.cast('  Office \n  party  !  ')).toBe('Office party!');
  });

  it('only trims secret phrases', () => {
    const schema = yup.object({ password: YupHelpers.password('Secret') });
    expect(schema.cast({ password: '  Jingle   Bells ' })).toEqual({ password: 'Jingle   Bells' });
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
