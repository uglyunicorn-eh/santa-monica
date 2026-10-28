import { describe, expect, it } from 'vitest';

import { renderAccountDeleted, renderAccountDeletion, renderEmailChange, renderEmailChangeNotice, renderEmailTakenNotice, renderPartyNotification, renderSignIn } from 'src/mail';
import { newObjectId } from 'src/utils/ids';
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

  it('makes every possible draw equally likely', () => {
    // Four people have 9 possible draws. 18,000 draws give each about 2,000; the old algorithm gave one of them 25%.
    const counts = new Map<string, number>();
    for (let run = 0; run < 18_000; run++) {
      const key = santaShuffle([0, 1, 2, 3]).map(d => d.target).join('');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(9);
    for (const [draw, n] of counts) {
      expect([draw, Math.abs(n - 2000) < 300]).toEqual([draw, true]);
    }
  });

  it('refuses a draw for fewer than two people', () => {
    expect(() => santaShuffle([1])).toThrow();
  });
});

describe('ids', () => {
  it('generates ObjectId-compatible ids that carry the creation time', () => {
    const id = newObjectId(1_700_000_000_000);
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    expect(parseInt(id.slice(0, 8), 16) * 1000).toBe(1_700_000_000_000);
  });

  it('round-trips node ids', () => {
    expect(strToNodeId(nodeIdToStr({ kind: 'Party', id: 'QWERT' }))).toEqual({ kind: 'Party', id: 'QWERT' });
    expect(() => strToNodeId('not base64 !')).toThrow();
  });
});

describe('mail templates', () => {
  it('fills the sign-in template with no SendGrid leftovers', () => {
    const mail = renderSignIn({ magicLink: 'https://gnomik.me/enter/link#abc.def', assetsUrl: 'https://api.test' });
    expect(mail.subject).toBe('Sign in to Anonymous Santa Clauses');
    expect(mail.html).toContain('href="https://gnomik.me/enter/link#abc.def"');
    expect(mail.html).toContain(`https://api.test/email/gnomik.png?v=${version}`);
    expect(mail.html).toContain('href="https://gnomik.me/terms/"');
    expect(mail.text).toContain('https://gnomik.me/enter/link#abc.def');
    expect(mail.html + mail.text).not.toMatch(/\{\{|sendgrid|sing in/);
  });

  it('escapes the party name in HTML but not in the subject', () => {
    const mail = renderPartyNotification({ party: { name: 'Tom & Jerry <3', url: 'https://gnomik.me/p/QWERT/' }, assetsUrl: 'https://api.test' });
    expect(mail.subject).toBe('Tom & Jerry <3: the dice are rolled!');
    expect(mail.html).not.toContain('Tom & Jerry <3');
    expect(mail.html).toContain('href="https://gnomik.me/p/QWERT/"');
    expect(mail.html + mail.text).not.toMatch(/\{\{|unsubscribe|sendgrid/i);
  });

  it('fills the account emails, escaping addresses in HTML only', () => {
    const deletion = renderAccountDeletion({ url: 'https://gnomik.me/profile/delete/abc', assetsUrl: 'https://api.test' });
    expect(deletion.text).toContain('https://gnomik.me/profile/delete/abc');
    expect(deletion.html).toContain('href="https://gnomik.me/profile/delete/abc"');
    // The inbox preview is a short line of its own, not the body again.
    expect(deletion.html).toMatch(/mso-hide:all;">Confirm with the link inside\. It works for an hour\.<\/div>/);

    const change = renderEmailChange({ url: 'https://gnomik.me/profile/email#abc', oldEmail: 'old@example.com', newEmail: 'a&b@example.com', assetsUrl: 'https://api.test' });
    expect(change.text).toContain('from old@example.com to a&b@example.com');
    expect(change.html).toContain('a&amp;b@example.com');
    expect(change.html).toContain('href="https://gnomik.me/profile/email#abc"');

    const notice = renderEmailChangeNotice({
      oldEmail: 'old@example.com', newEmail: 'new@example.com', cancelUrl: 'https://gnomik.me/profile/email/cancel#abc', assetsUrl: 'https://api.test',
    });
    expect(notice.text).toContain('from old@example.com to new@example.com');
    expect(notice.text).toContain('https://gnomik.me/profile/email/cancel#abc');
    expect(notice.html).toContain('href="https://gnomik.me/profile/email/cancel#abc"');
    expect(notice.html).toContain("This wasn&#39;t me");

    const taken = renderEmailTakenNotice({ email: 'a&b@example.com', assetsUrl: 'https://api.test' });
    expect(taken.text).toContain('another Anonymous Santa Clauses account to a&b@example.com');
    expect(taken.html).toContain('a&amp;b@example.com');
    expect([...taken.html.matchAll(/href="([^"]*)"/g)].map(m => m[1])).toEqual(['https://uglyunicorn.ca/']);
    const deleted = renderAccountDeleted({ assetsUrl: 'https://api.test' });
    expect(deleted.subject).toBe('Your Anonymous Santa Clauses account is deleted');
    expect(deleted.text).toContain("It's officially over");
    expect(deleted.html).toContain(`https://api.test/email/farewell.png?v=${version}`);
    expect(deleted.html).not.toContain('gnomik.png');
    expect(deleted.html + deleted.text).toContain('Tchau, Anonymous Santa Claus!');
    expect([...deleted.html.matchAll(/href="([^"]*)"/g)].map(m => m[1])).toEqual(['https://uglyunicorn.ca/']);
    for (const mail of [deletion, change, notice, taken, deleted]) {
      expect(`${mail.subject}${mail.html}${mail.text}`).not.toMatch(/\{\{|ACTION_ROW/);
    }
  });
});
