import { withoutAction } from './simple';

// Sent once an account is deleted (from the deletion link). Placeholders: {{assetsUrl}}, {{assetsVersion}}.
export const subject = 'Your Anonymous Santa Clauses account is deleted';

export const vars = {
  title: "It's officially over",
  preheader: "Done, as you asked. We'll keep the cocoa warm.",
  body: "We've deleted your Anonymous Santa Clauses account, as you asked. The parties you hosted that hadn't rolled the dice are gone, and you've left the open parties you joined. In parties that already rolled, your Secret Santa keeps the name you joined with, and nothing else about you.",
  footer: "If you ever miss us, just sign in again with this email. We'll keep the cocoa warm.",
};

export const html = withoutAction;

export const text = `${vars.title}

${vars.body}

${vars.footer}
`;
