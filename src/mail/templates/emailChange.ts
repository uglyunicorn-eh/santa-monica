import { actionColors, withAction } from './simple';

// Sent to the NEW address. Placeholders: {{url}}, {{oldEmail}}, {{newEmail}}, {{assetsUrl}}, {{assetsVersion}}.
export const subject = 'Confirm your new email for Anonymous Ded Morozes';

export const vars = {
  title: 'Confirm your new email',
  action: 'Use this email',
  actionColor: actionColors.go,
  footer: "The link works for an hour. If you didn't ask for this, ignore this email and nothing will change.",
};

export const body = 'Someone, hopefully you, asked to change the email of an Anonymous Ded Morozes account from {{oldEmail}} to {{newEmail}}. Confirm it to sign in with this address from now on.';

export const html = withAction;

export const text = `Confirm your new email

${body}

To confirm, open this link:
{{url}}

${vars.footer}
`;
