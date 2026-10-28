// The one layout every email uses, styled like the site (santa-barbara's docs/ui-kit.md): a white card on a light
// grey page, the Cuprum font (Trebuchet where a mail app can't load it), teal links, and pill buttons.
// What goes in may hold {{placeholders}}; render() fills them later, HTML-escaping the values.

const FONT = "Cuprum, 'Trebuchet MS', Helvetica, Arial, sans-serif";

const color = {
  page: '#f4f4f5', // zinc-100
  card: '#ffffff',
  border: '#e4e4e7', // zinc-200
  text: '#18181b', // zinc-900
  muted: '#71717a', // zinc-500
  link: '#007a68', // teal-700
};

/** Button colours, as in the app: turquoise with a dark label to go ahead, red to stop or delete something. */
export const actionTones = {
  go: { actionColor: '#33dac1', actionTextColor: '#04342c' }, // primary: teal-400 / teal-900
  stop: { actionColor: '#a8222a', actionTextColor: '#ffffff' }, // destructive: red-700
};

type Options = {
  /** The line mail apps show beside the subject. */
  preheader: string;
  /**
   * "greeting": "Hola, Anonymous Santa Claus!" beside the gnome. Otherwise, an image across the card, and with
   * `greeting`, that line under it as the big heading (the account-deleted email's "Tchau…").
   */
  header: 'greeting' | { image: string; greeting?: string };
  title: string;
  titleAlign?: 'left' | 'center';
  /** HTML: paragraphs from p(). */
  body: string;
  action?: { label: string; url: string; color: string; textColor: string };
  /** HTML: the small print under the button. */
  note: string;
};

/** A body paragraph. */
export const p = (html: string) =>
  `<p style="margin:0 0 16px; font-family:${FONT}; font-size:18px; line-height:27px; color:${color.text};">${html}</p>`;

/** A link in the body. */
export const a = (href: string, label: string) =>
  `<a href="${href}" target="_blank" style="color:${color.link}; text-decoration:underline;">${label}</a>`;

const greeting = `<tr>
              <td style="padding:0 0 8px;">
                <table class="column" width="250" cellpadding="0" cellspacing="0" border="0" align="left" style="width:250px;">
                  <tr>
                    <td style="padding:16px 0 0;"><h1 style="margin:0; font-family:${FONT}; font-size:32px; line-height:38px; font-weight:700; color:${color.text};">Hola, Anonymous Santa Claus!</h1></td>
                  </tr>
                </table>
                <table class="column" width="250" cellpadding="0" cellspacing="0" border="0" align="right" style="width:250px;">
                  <tr>
                    <td align="center"><img src="{{assetsUrl}}/email/gnomik.png?v={{assetsVersion}}" width="200" alt="" style="display:block; margin:0 auto; width:200px; max-width:100%; height:auto; border:0;"></td>
                  </tr>
                </table>
              </td>
            </tr>`;

const image = (src: string) => `<tr>
              <td style="padding:0 0 8px;"><img src="${src}" width="534" alt="" style="display:block; width:100%; max-width:534px; height:auto; border:0; border-radius:8px;"></td>
            </tr>`;

const heading = (text: string) => `<tr>
              <td style="padding:16px 0 0;"><h1 style="margin:0; font-family:${FONT}; font-size:32px; line-height:38px; font-weight:700; color:${color.text};">${text}</h1></td>
            </tr>`;

const button = ({ label, url, color: bg, textColor }: NonNullable<Options['action']>) => `<tr>
              <td align="center" style="padding:16px 0 8px;">
                <table cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" bgcolor="${bg}" style="border-radius:999px; background-color:${bg};">
                      <a href="${url}" target="_blank" style="display:inline-block; padding:12px 24px; border-radius:999px; background-color:${bg}; color:${textColor}; font-family:${FONT}; font-size:20px; line-height:24px; font-weight:600; text-decoration:none;">${label}</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`;

export const layout = ({ preheader, header, title, titleAlign = 'left', body, action, note }: Options) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <style type="text/css">
      @import url("https://fonts.googleapis.com/css2?family=Cuprum:wght@400..700&display=swap");
      a { color:${color.link}; }
      @media screen and (max-width:480px) {
        .column { display:block !important; width:100% !important; float:none !important; }
        .card { padding:24px 20px !important; }
      }
    </style>
  </head>
  <body style="margin:0; padding:0; background-color:${color.page}; font-family:${FONT}; color:${color.text};">
    <div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">${preheader}</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${color.page}" style="background-color:${color.page};">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
            <tr>
              <td class="card" bgcolor="${color.card}" style="padding:32px; background-color:${color.card}; border:1px solid ${color.border}; border-radius:16px;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0">
            ${header === 'greeting' ? greeting : image(header.image) + (header.greeting ? heading(header.greeting) : '')}
            <tr>
              <td align="${titleAlign}" style="padding:16px 0 12px;"><h2 style="margin:0; font-family:${FONT}; font-size:24px; line-height:30px; font-weight:600; color:${color.text}; text-align:${titleAlign};">${title}</h2></td>
            </tr>
            <tr>
              <td>${body}</td>
            </tr>
            ${action ? button(action) : ''}
            <tr>
              <td style="padding:16px 0 0; font-family:${FONT}; font-size:15px; line-height:22px; color:${color.muted};">${note}</td>
            </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:24px 0 8px;">
                <a href="https://uglyunicorn.ca/"><img src="{{assetsUrl}}/email/uglyunicorn.png?v={{assetsVersion}}" width="48" height="48" alt="Home of Ugly Unicorn" style="display:block; border:0;"></a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
