import { layout, p } from './layout';

// The account emails: the greeting beside the gnome, a heading, the text, maybe a button, and a short note.
// Placeholders: {{preheader}} (a short line, not the body again), {{title}}, {{body}}, {{action}}, {{url}}, {{actionColor}}, {{actionTextColor}}, {{footer}},
// {{assetsUrl}}, {{assetsVersion}}. Values are filled by render(), which HTML-escapes them in the HTML part.

export { actionTones } from './layout';

const common = { preheader: '{{preheader}}', header: 'greeting', title: '{{title}}', body: p('{{body}}'), note: '{{footer}}' } as const;

export const withAction = layout({
  ...common,
  action: { label: '{{action}}', url: '{{url}}', color: '{{actionColor}}', textColor: '{{actionTextColor}}' },
});

export const withoutAction = layout(common);
