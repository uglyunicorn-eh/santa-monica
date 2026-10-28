import { layout, p } from './layout';

// Sent once an account is deleted (from the deletion link): a goodbye, with Gnomik's postcard from Canada instead of
// the waving boy. Placeholders: {{preheader}}, {{title}}, {{body}}, {{footer}} (from `vars`), {{assetsUrl}},
// {{assetsVersion}}.
export const subject = 'Your Anonymous Santa Clauses account is deleted';

const greeting = 'Tchau, Anonymous Santa Claus!';

export const vars = {
  title: "It's officially over",
  preheader: "Done, as you asked. We'll keep the cocoa warm.",
  body: "We've deleted your Anonymous Santa Clauses account, as you asked. The parties you hosted that hadn't rolled the dice are gone, and you've left the open parties you joined. In parties that already rolled, your Secret Santa keeps the name you joined with, and nothing else about you.",
  footer: "If you ever miss us, just sign in again with this email. We'll keep the cocoa warm.",
};

export const html = layout({
  preheader: '{{preheader}}',
  header: { image: '{{assetsUrl}}/email/farewell.png?v={{assetsVersion}}', greeting },
  title: '{{title}}',
  body: p('{{body}}'),
  note: '{{footer}}',
});

export const text = `${greeting}

${vars.title}

${vars.body}

${vars.footer}
`;
