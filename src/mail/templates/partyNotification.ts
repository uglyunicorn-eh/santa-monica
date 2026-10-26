import { a, actionTones, layout, p } from './layout';

// Placeholders: {{party.name}}, {{party.url}}, {{assetsUrl}}, {{assetsVersion}}.
export const subject = "{{party.name}}";

export const html = layout({
  preheader: "Good day, beautiful person! We have some wonderful news to share... It's time! It's time to make someone happy!",
  header: { image: '{{assetsUrl}}/email/party.gif?v={{assetsVersion}}' },
  title: "This is it! The message you've been waiting for!",
  titleAlign: 'center',
  body: p('Good day, beautiful person!')
    + p("We have some wonderful news to share... <strong>It's time!</strong> It's time to make someone happy!")
    + p('Our elves have just finished their complex calculations, and now they know your person of interest! Simply follow the link below and ask the gnome for the answer to the most mysterious question of the Universe...'),
  action: { label: '🦄 Get me to the Gnomik!', url: '{{party.url}}', color: actionTones.go.actionColor, textColor: actionTones.go.actionTextColor },
  note: `P.S. If you enjoyed this experience, please consider supporting me by ${a('https://www.buymeacoffee.com/uglyunicorn', 'buying me a coffee')} ☕`,
});

export const text = `Good day, beautiful person! We have some wonderful news to share... It's time! It's time to make someone happy!

This is it! The message you've been waiting for!

Good day, beautiful person!

We have some wonderful news to share... *It's time!* It's time to make someone happy!

Our elves have just finished their complex calculations, and now they know your person of interest! Simply follow the link below and ask the gnome for the answer to the most mysterious question of the Universe...

🦄 Get me to the Gnomik! ( {{party.url}} )

P.S. If you enjoyed this experience, please consider supporting me by buying me a coffee ( https://www.buymeacoffee.com/uglyunicorn ) ☕

Home of Ugly Unicorn ( https://uglyunicorn.ca/ )`;
