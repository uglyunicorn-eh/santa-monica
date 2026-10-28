import { withoutAction } from './simple';

// Sent to an address that already has an account, when someone asks to move another account to it, instead of
// telling the one asking that it's taken. Placeholders: {{email}}, {{assetsUrl}}, {{assetsVersion}}.
export const subject = 'Someone tried to use your email on Anonymous Santa Clauses';

export const vars = {
  title: 'Your email is already in use',
  preheader: 'Nothing changed: this address already has its own account.',
  footer: "If it was you, sign in with this address instead. If it wasn't, you can ignore this email.",
};

export const body = 'Someone asked to move another Anonymous Santa Clauses account to {{email}}. This address already has its own account, so nothing changed.';

export const html = withoutAction;

export const text = `Your email is already in use

${body}

${vars.footer}
`;
