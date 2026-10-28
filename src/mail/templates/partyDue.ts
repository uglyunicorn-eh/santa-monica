import { actionTones, withAction } from './simple';

// Sent to the host the day before the party starts: the due time is roughly when they mean to roll the dice
// (src/do/PartyDO.ts, `remindIfDue`). Placeholders: {{party.name}}, {{url}} (the party page), {{members}} (how many
// people are in), {{assetsUrl}}, {{assetsVersion}}.
export const subject = '{{party.name}} starts in about a day';

export const vars = {
  title: 'Your party starts in about a day',
  preheader: "It's almost time to roll the dice.",
  action: 'Open the party',
  ...actionTones.go,
  footer: "It's only a reminder: nothing happens on its own, and you roll the dice when you're ready.",
};

export const body = "You planned to roll the dice for {{party.name}} in about a day, and {{members}} so far. Once everyone's in, roll the dice and let the gifting begin.";

export const html = withAction;

export const text = `Your party starts in about a day

${body}

To open it, follow this link:
{{url}}

${vars.footer}
`;
