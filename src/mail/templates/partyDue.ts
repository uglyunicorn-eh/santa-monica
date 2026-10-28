import { actionTones, withAction } from './simple';

// Sent to the host the day before the party's due time (src/do/PartyDO.ts, `remindIfDue`). Placeholders:
// {{party.name}}, {{url}} (the party page), {{members}} (how many people are in), {{assetsUrl}}, {{assetsVersion}}.
export const subject = '{{party.name}} is due in about a day';

export const vars = {
  title: 'Your party is due in about a day',
  action: 'Open the party',
  ...actionTones.go,
  footer: "The due time is only a reminder: nothing happens when it passes, and you roll the dice when you're ready.",
};

export const body = '{{party.name}} is due in about a day, and {{members}} so far. Once everyone is in, roll the dice so the gifts can begin.';

export const html = withAction;

export const text = `Your party is due in about a day

${body}

To open it, follow this link:
{{url}}

${vars.footer}
`;
