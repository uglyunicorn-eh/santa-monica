import { actionTones, layout, p } from './layout';

// Placeholders: {{host.name}}, {{party.name}}, {{party.url}} (with the invite token after "#"), {{phraseNote}}, {{assetsUrl}}, {{assetsVersion}}.
// The host's and party's names are the host's own words: they go in the body (escaped), never in the subject, and the
// secret phrase is never sent.
export const subject = "You're invited to a Secret Santa party!";

export const html = layout({
  preheader: '{{host.name}} invites you to {{party.name}}. Join in, and Gnomik will tell you whom you give a gift to.',
  header: 'greeting',
  title: "You're invited!",
  body: p('<strong>{{host.name}}</strong> invites you to <strong>{{party.name}}</strong>, a Secret Santa party with Gnomik.')
    + p('Join in, and once everyone is there, our elves will draw names: each of you gets one person to surprise with a gift.')
    + p('{{phraseNote}}'),
  action: { label: '🎉 Join the party', url: '{{party.url}}', color: actionTones.go.actionColor, textColor: actionTones.go.actionTextColor },
  note: "The button signs you in, so please don't forward this email. You got it because {{host.name}} typed your address: if you don't know them, just ignore it.",
});

export const text = `{{host.name}} invites you to {{party.name}}. Join in, and Gnomik will tell you whom you give a gift to.

You're invited!

{{host.name}} invites you to {{party.name}}, a Secret Santa party with Gnomik.

Join in, and once everyone is there, our elves will draw names: each of you gets one person to surprise with a gift.

{{phraseNote}}

🎉 Join the party ( {{party.url}} )

The button signs you in, so please don't forward this email. You got it because {{host.name}} typed your address: if you don't know them, just ignore it.

Home of Ugly Unicorn ( https://uglyunicorn.ca/ )`;

/** The line about the secret phrase: the host tells it, we never email it. */
export const phraseNotes = {
  protected: 'The party has a secret phrase: ask {{host.name}} for it before you join.',
  open: 'All it takes is the link below.',
};
