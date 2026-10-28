import { actionTones, withAction } from './simple';

// Sent to the host when an open party is deleted after PRUNE_AFTER_MS without activity (src/do/PartyDO.ts).
// Placeholders: {{party.name}}, {{url}} (the party page, where the host can restore it), {{until}}, {{assetsUrl}},
// {{assetsVersion}}.
export const subject = '{{party.name}} was put away';

export const vars = {
  title: 'We put your party away',
  action: 'Bring it back',
  ...actionTones.go,
  footer: "If you don't need it any more, there's nothing to do: it goes for good after that date, with everyone's details.",
};

export const body = 'Nothing happened in {{party.name}} for 45 days, and its dice were never rolled, so we deleted it. You can bring it back, just as it was, until {{until}}.';

export const html = withAction;

export const text = `We put your party away

${body}

To bring it back, open this link:
{{url}}

${vars.footer}
`;
