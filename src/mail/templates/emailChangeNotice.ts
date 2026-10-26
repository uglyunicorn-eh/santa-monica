import { actionTones, withAction } from './simple';

// Sent to the OLD address. Placeholders: {{oldEmail}}, {{newEmail}}, {{url}} (cancels the change), {{assetsUrl}},
// {{assetsVersion}}.
export const subject = 'Your Anonymous Ded Morozes email is being changed';

export const vars = {
  title: 'Email change requested',
  action: "This wasn't me",
  ...actionTones.stop,
  footer: "If it was you, there's nothing to do. If it wasn't, the button stops the change and signs out every device signed in to your account. It works for an hour.",
};

export const body = 'Someone asked to change the email of your Anonymous Ded Morozes account from {{oldEmail}} to {{newEmail}}. Nothing changes until the link sent to {{newEmail}} is opened.';

export const html = withAction;

export const text = `Email change requested

${body}

If this wasn't you, open this link to stop the change and sign out everywhere:
{{url}}

${vars.footer}
`;
