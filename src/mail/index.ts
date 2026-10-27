import { Env } from 'src/env';

import * as accountDeleted from './templates/accountDeleted';
import * as accountDeletion from './templates/accountDeletion';
import * as emailChange from './templates/emailChange';
import * as emailChangeNotice from './templates/emailChangeNotice';
import * as emailTakenNotice from './templates/emailTakenNotice';
import * as partyInvite from './templates/partyInvite';
import * as partyNotification from './templates/partyNotification';
import * as partyPruned from './templates/partyPruned';
import * as signIn from './templates/signIn';

import { from } from 'src/config.json';
import { version } from 'package.json';

// Image URLs carry the version, so a mail client or image proxy never shows a stale (or earlier failed) fetch.
const assetsVersion = version;

export type MailMessage = {
  subject: string;
  html: string;
  text: string;
};

type Template = { subject: string; html: string; text: string };

const escapeHtml = (s: string) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const fill = (s: string, vars: Record<string, string>, escape: (s: string) => string) =>
  s.replace(/\{\{([\w.]+)\}\}/g, (match, key: string) => (key in vars ? escape(vars[key]) : match));

/** Fills `{{name}}` placeholders, HTML-escaping values in the HTML part. Unknown placeholders are left as they are. */
export const render = (template: Template, vars: Record<string, string>): MailMessage => ({
  subject: fill(template.subject, vars, s => s),
  html: fill(template.html, vars, escapeHtml),
  text: fill(template.text, vars, s => s),
});

export const renderSignIn = ({ magicLink, assetsUrl }: { magicLink: string; assetsUrl: string }) =>
  render(signIn, { magicLink, assetsUrl, assetsVersion });

export const renderPartyNotification = ({ party, assetsUrl }: { party: { name: string; url: string }; assetsUrl: string }) =>
  render(partyNotification, { 'party.name': party.name, 'party.url': party.url, assetsUrl, assetsVersion });

export const renderAccountDeleted = ({ assetsUrl }: { assetsUrl: string }) =>
  render(accountDeleted, { ...accountDeleted.vars, assetsUrl, assetsVersion });

export const renderAccountDeletion = ({ url, assetsUrl }: { url: string; assetsUrl: string }) =>
  render(accountDeletion, { ...accountDeletion.vars, url, assetsUrl, assetsVersion });

// The body has placeholders of its own, so it is filled first (as plain text: render escapes it once, in the HTML part).
const fillBody = (body: string, vars: Record<string, string>) => fill(body, vars, s => s);

/** The host's notice that an open party was deleted for want of activity, with the date until which it can come back. */
export const renderPartyPruned = ({ party, restorableUntil, assetsUrl }: { party: { name: string; url: string }; restorableUntil: number; assetsUrl: string }) => {
  const until = new Date(restorableUntil).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const vars = { 'party.name': party.name, url: party.url, until, assetsUrl, assetsVersion };
  return render(partyPruned, { ...partyPruned.vars, ...vars, body: fillBody(partyPruned.body, vars) });
};

export const renderPartyInvite = ({ hostName, party, assetsUrl }: { hostName: string; party: { name: string; url: string; isProtected: boolean }; assetsUrl: string }) => {
  const vars = { 'host.name': hostName, 'party.name': party.name, 'party.url': party.url, assetsUrl, assetsVersion };
  const phraseNote = fillBody(party.isProtected ? partyInvite.phraseNotes.protected : partyInvite.phraseNotes.open, vars);
  return render(partyInvite, { ...vars, phraseNote });
};

export const renderEmailChange = ({ url, oldEmail, newEmail, assetsUrl }: { url: string; oldEmail: string; newEmail: string; assetsUrl: string }) => {
  const vars = { url, oldEmail, newEmail, assetsUrl, assetsVersion };
  return render(emailChange, { ...emailChange.vars, ...vars, body: fillBody(emailChange.body, vars) });
};

export const renderEmailChangeNotice = ({ oldEmail, newEmail, cancelUrl, assetsUrl }: { oldEmail: string; newEmail: string; cancelUrl: string; assetsUrl: string }) => {
  const vars = { oldEmail, newEmail, url: cancelUrl, assetsUrl, assetsVersion };
  return render(emailChangeNotice, { ...emailChangeNotice.vars, ...vars, body: fillBody(emailChangeNotice.body, vars) });
};

export const renderEmailTakenNotice = ({ email, assetsUrl }: { email: string; assetsUrl: string }) => {
  const vars = { email, assetsUrl, assetsVersion };
  return render(emailTakenNotice, { ...emailTakenNotice.vars, ...vars, body: fillBody(emailTakenNotice.body, vars) });
};

/**
 * Whether `to` may get email from this Worker. `allowlist` is EMAIL_ALLOWLIST: comma-separated addresses and `@domain`
 * entries. Public PR previews set it, so they can't be used to email just anyone; production doesn't.
 */
export function recipientAllowed(allowlist: string | undefined, to: string): boolean {
  if (allowlist === undefined) {
    return true;
  }
  const address = to.toLowerCase();
  return allowlist.split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean)
    .some(entry => (entry.startsWith('@') ? address.endsWith(entry) : address === entry));
}

export const sendMail = async (env: Env, to: string, message: MailMessage) => {
  if (!recipientAllowed(env.EMAIL_ALLOWLIST, to)) {
    throw Object.assign(new Error('This environment only emails the addresses in EMAIL_ALLOWLIST.'), { code: 'E_RECIPIENT_NOT_ALLOWED' });
  }
  await env.EMAIL.send({
    to,
    from: { email: from.email, name: from.name },
    subject: message.subject,
    html: message.html,
    text: message.text,
  });
};

/**
 * Errors that will not go away by retrying the same message. Sender and domain setup errors are not here:
 * they are fixed in the account, after which the retries go through.
 */
export const isPermanentMailError = (error: unknown) => {
  const code = (error as { code?: string } | null)?.code;
  return code === 'E_RECIPIENT_SUPPRESSED'
    || code === 'E_RECIPIENT_NOT_ALLOWED'
    || code === 'E_VALIDATION_ERROR'
    || code === 'E_FIELD_MISSING';
};
