import { a, actionTones, layout, p } from './layout';

// Placeholders: {{party.name}}, {{party.url}}, {{assetsUrl}}, {{assetsVersion}}.
export const subject = "{{party.name}}: the dice are rolled!";

export const html = layout({
  preheader: "Good day, beautiful person! We have wonderful news: it's time to make someone happy!",
  header: { image: '{{assetsUrl}}/email/party.gif?v={{assetsVersion}}' },
  title: "This is it! The message you've been waiting for!",
  titleAlign: 'center',
  body: p('Good day, beautiful person!')
    + p("We have wonderful news: <strong>it's time!</strong> It's time to make someone happy!")
    + p('Our elves have finished their calculations, and now they know your person of interest! Follow the link below and ask Gnomik the most mysterious question of the Universe...'),
  action: { label: '🦄 Get me to Gnomik!', url: '{{party.url}}', color: actionTones.go.actionColor, textColor: actionTones.go.actionTextColor },
  note: `P.S. If you enjoyed this experience, please consider supporting me by ${a('https://www.buymeacoffee.com/uglyunicorn', 'buying me a coffee')} ☕`,
});

export const text = `Good day, beautiful person! We have wonderful news: it's time to make someone happy!

This is it! The message you've been waiting for!

Good day, beautiful person!

We have wonderful news: *it's time!* It's time to make someone happy!

Our elves have finished their calculations, and now they know your person of interest! Follow the link below and ask Gnomik the most mysterious question of the Universe...

🦄 Get me to Gnomik! ( {{party.url}} )

P.S. If you enjoyed this experience, please consider supporting me by buying me a coffee ( https://www.buymeacoffee.com/uglyunicorn ) ☕

Home of Ugly Unicorn ( https://uglyunicorn.ca/ )`;
