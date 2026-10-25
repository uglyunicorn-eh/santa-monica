import { describe, expect, it } from 'vitest';

import { renderAccountDeletion, renderEmailChange, renderEmailChangeNotice, renderPartyNotification, renderSignIn } from 'src/mail';
import { isObjectId, newObjectId, objectIdTime } from 'src/utils/ids';
import santaShuffle from 'src/utils/santaShuffle';
import { nodeIdToStr, strToNodeId } from 'src/utils/strings/nodeId';

import { version } from 'package.json';

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
    expect(mail.html).toContain(`https://api.test/email/gnomik.png?v=${version}`);
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

  it('fills the account emails, escaping addresses in HTML only', () => {
    const deletion = renderAccountDeletion({ url: 'https://gnomik.me/profile/delete/abc', assetsUrl: 'https://api.test' });
    expect(deletion.text).toContain('https://gnomik.me/profile/delete/abc');
    expect(deletion.html).toContain('href="https://gnomik.me/profile/delete/abc"');

    const change = renderEmailChange({ url: 'https://gnomik.me/profile/email/abc', oldEmail: 'old@example.com', newEmail: 'a&b@example.com', assetsUrl: 'https://api.test' });
    expect(change.text).toContain('from old@example.com to a&b@example.com');
    expect(change.html).toContain('a&amp;b@example.com');
    expect(change.html).toContain('href="https://gnomik.me/profile/email/abc"');

    const notice = renderEmailChangeNotice({ oldEmail: 'old@example.com', newEmail: 'new@example.com', assetsUrl: 'https://api.test' });
    expect(notice.text).toContain('from old@example.com to new@example.com');
    expect(notice.html).not.toContain('href=');
    for (const mail of [deletion, change, notice]) {
      expect(`${mail.subject}${mail.html}${mail.text}`).not.toMatch(/\{\{|ACTION_ROW/);
    }
  });
});
