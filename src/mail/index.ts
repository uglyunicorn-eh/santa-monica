import { Env } from 'src/env';

import * as accountDeletion from './templates/accountDeletion';
import * as emailChange from './templates/emailChange';
import * as emailChangeNotice from './templates/emailChangeNotice';
import * as emailTakenNotice from './templates/emailTakenNotice';
import * as partyNotification from './templates/partyNotification';
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

export const renderAccountDeletion = ({ url, assetsUrl }: { url: string; assetsUrl: string }) =>
  render(accountDeletion, { ...accountDeletion.vars, url, assetsUrl, assetsVersion });

// The body has placeholders of its own, so it is filled first (as plain text: render escapes it once, in the HTML part).
const fillBody = (body: string, vars: Record<string, string>) => fill(body, vars, s => s);

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

export const sendMail = async (env: Env, to: string, message: MailMessage) => {
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
    || code === 'E_VALIDATION_ERROR'
    || code === 'E_FIELD_MISSING';
};
