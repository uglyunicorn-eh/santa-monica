import { describe, expect, it } from 'vitest';

import { renderPartyNotification, renderSignIn } from 'src/mail';
import { isObjectId, newObjectId, objectIdTime } from 'src/utils/ids';
import santaShuffle from 'src/utils/santaShuffle';
import { nodeIdToStr, strToNodeId } from 'src/utils/strings/nodeId';

describe('santaShuffle', () => {
  it('always gives everyone exactly one target who is not themselves', () => {
    for (let n = 2; n <= 12; n++) {
      for (let run = 0; run < 50; run++) {
        const people = Array.from({ length: n }, (_, i) => i);
        const draws = santaShuffle(people);
        expect(draws.every(d => d.src !== d.target)).toBe(true);
        expect(new Set(draws.map(d => d.target)).size).toBe(n);
      }
    }
  });

  it('refuses a draw for fewer than two people', () => {
    expect(() => santaShuffle([1])).toThrow();
  });
});

describe('ids', () => {
  it('generates ObjectId-compatible ids that carry the creation time', () => {
    const id = newObjectId(1_700_000_000_000);
    expect(isObjectId(id)).toBe(true);
    expect(objectIdTime(id)).toBe(1_700_000_000_000);
  });

  it('round-trips node ids', () => {
    expect(strToNodeId(nodeIdToStr({ kind: 'Party', id: 'QWERT' }))).toEqual({ kind: 'Party', id: 'QWERT' });
    expect(() => strToNodeId('not base64 !')).toThrow();
  });
});

describe('mail templates', () => {
  it('fills the sign-in template with no SendGrid leftovers', () => {
    const mail = renderSignIn({ magicLink: 'https://gnomik.me/enter/abc.def', assetsUrl: 'https://api.test' });
    expect(mail.subject).toBe('Sign in to Anonymous Ded Morozes');
    expect(mail.html).toContain('href="https://gnomik.me/enter/abc.def"');
    expect(mail.html).toContain('https://api.test/email/gnomik.png');
    expect(mail.html).toContain('href="https://gnomik.me/terms/"');
    expect(mail.text).toContain('https://gnomik.me/enter/abc.def');
    expect(mail.html + mail.text).not.toMatch(/\{\{|sendgrid|sing in/);
  });

  it('escapes the party name in HTML but not in the subject', () => {
    const mail = renderPartyNotification({ party: { name: 'Tom & Jerry <3', url: 'https://gnomik.me/p/QWERT/' }, assetsUrl: 'https://api.test' });
    expect(mail.subject).toBe('Tom & Jerry <3');
    expect(mail.html).not.toContain('Tom & Jerry <3');
    expect(mail.html).toContain('href="https://gnomik.me/p/QWERT/"');
    expect(mail.html + mail.text).not.toMatch(/\{\{|unsubscribe|sendgrid/i);
  });
});
