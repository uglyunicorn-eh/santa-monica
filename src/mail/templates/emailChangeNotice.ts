import { withoutAction } from './simple';

// Sent to the OLD address. Placeholders: {{oldEmail}}, {{newEmail}}, {{assetsUrl}}, {{assetsVersion}}.
export const subject = 'Your Anonymous Ded Morozes email is being changed';

export const vars = {
  title: 'Email change requested',
  footer: "If you didn't ask for this, someone may have access to your account: just don't confirm, and sign out on devices you don't recognize.",
};

export const body = 'Someone asked to change the email of your Anonymous Ded Morozes account from {{oldEmail}} to {{newEmail}}. Nothing changes until the link sent to {{newEmail}} is opened.';

export const html = withoutAction;

export const text = `Email change requested

${body}

${vars.footer}
`;
