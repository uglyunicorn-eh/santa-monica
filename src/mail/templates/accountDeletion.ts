import { actionTones, withAction } from './simple';

// Placeholders: {{url}}, {{assetsUrl}}, {{assetsVersion}}.
export const subject = 'Confirm deleting your Anonymous Santa Clauses account';

export const vars = {
  title: 'Delete your account?',
  body: 'Someone, hopefully you, asked to delete your Anonymous Santa Clauses account. Parties you host that are not drawn yet will be deleted, and you will leave the open parties you joined. In parties that are already drawn, your Secret Santa keeps the name you joined with, but nothing else about you. This cannot be undone.',
  action: 'Delete my account',
  ...actionTones.stop,
  footer: "The link works for an hour. If you didn't ask for this, ignore this email and nothing will change.",
};

export const html = withAction;

export const text = `Delete your account?

${vars.body}

To delete your account, open this link:
{{url}}

${vars.footer}
`;
