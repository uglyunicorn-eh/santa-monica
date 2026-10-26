import { a, actionTones, layout, p } from './layout';

// Placeholders: {{magicLink}}, {{assetsUrl}}, {{assetsVersion}}.
export const subject = "Sign in to Anonymous Ded Morozes";

export const html = layout({
  preheader: 'Olá, bonjour, привіт! Please follow the link to sign in to the Anonymous Ded Morozes, the most fun and friendly game!',
  header: 'greeting',
  title: 'Your magic link is ready!',
  body: p("If you didn't request this email, there's nothing to worry about — you can safely ignore it.")
    + p(`Please review our ${a('https://gnomik.me/terms/', 'Terms and Conditions')}, and ${a('https://gnomik.me/privacy/', 'Privacy Policy')} prior signing in.`),
  action: { label: '🥳 Sign in now', url: '{{magicLink}}', color: actionTones.go.actionColor, textColor: actionTones.go.actionTextColor },
  note: 'Please note that the magic link is available for a short period of time and will be expired in about 5 minutes. If you need more time just request another one.',
});

export const text = `Olá, bonjour, привіт! Please follow the link to sign in to the Anonymous Ded Morozes, the most fun and friendly game!

**************************
Hola, Anonymous Ded Moroz!
**************************

-------------------------
Your magic link is ready!
-------------------------

If you didn't request this email, there's nothing to worry about — you can safely ignore it.

Please review our Terms and Conditions ( https://gnomik.me/terms/ ), and Privacy Policy ( https://gnomik.me/privacy/ ) prior signing in.

🥳 Sign in now ( {{magicLink}} )

Please note that the magic link is available for a short period of time and will be expired in about 5 minutes. If you need more time just request another one.

Home of Ugly Unicorn ( https://uglyunicorn.ca/ )`;
