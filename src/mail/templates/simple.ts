// The layout of the account emails, matching the sign-in email: a greeting beside the gnome, a heading, the text, a
// button, a short note, and the Ugly Unicorn logo. Placeholders: {{title}}, {{body}}, {{action}}, {{url}},
// {{actionColor}}, {{footer}}, {{assetsUrl}}, {{assetsVersion}}. Values are filled by render(), which HTML-escapes them
// in the HTML part.
export const html = `<!DOCTYPE html>
<html>
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style type="text/css">
      @media screen and (max-width:480px) {
        .column { display:block !important; width:100% !important; margin:0 !important; }
      }
    </style>
  </head>
  <body style="margin:0; padding:0; background-color:#e7ebec; font-family:trebuchet ms,helvetica,sans-serif; font-size:14px; color:#000000;">
    <div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">{{body}}</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#e7ebec">
      <tr>
        <td align="center" style="padding:20px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
            <tr>
              <td>
                <table class="column" width="270" cellpadding="0" cellspacing="0" border="0" align="left" style="width:270px; margin:0 10px 0 0;">
                  <tr>
                    <td style="padding:18px 0 0; line-height:40px;"><h1 style="margin:0; font-size:28px;">Hola, Anonymous Ded Moroz!</h1></td>
                  </tr>
                </table>
                <table class="column" width="270" cellpadding="0" cellspacing="0" border="0" align="left" style="width:270px; margin:0 0 0 10px;">
                  <tr>
                    <td align="center">
                      <img src="{{assetsUrl}}/email/gnomik.png?v={{assetsVersion}}" width="216" alt="" style="display:block; width:80%; max-width:216px; height:auto;">
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 0 10px; line-height:30px;"><h2 style="margin:0; font-size:21px;">{{title}}</h2></td>
            </tr>
            <tr>
              <td style="font-size:16px; line-height:22px;">{{body}}</td>
            </tr>
            ACTION_ROW
            <tr>
              <td style="padding:28px 0 18px; font-size:14px; line-height:18px; color:#737373;">{{footer}}</td>
            </tr>
            <tr>
              <td style="padding:16px 0;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="1" bgcolor="#c6c2c2" style="font-size:1px; line-height:1px;">&nbsp;</td></tr></table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 0 18px;">
                <a href="https://uglyunicorn.ca/"><img src="{{assetsUrl}}/email/uglyunicorn.png?v={{assetsVersion}}" width="64" height="64" alt="Home of Ugly Unicorn" style="display:block; border:0;"></a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;

const actionRow = `<tr>
              <td align="center" style="padding:30px 0 0;">
                <a href="{{url}}" target="_blank" style="display:inline-block; padding:12px 18px; background-color:{{actionColor}}; border:1px solid {{actionColor}}; border-radius:4px; color:#ffffff; font-size:18px; line-height:normal; text-decoration:none;">{{action}}</a>
              </td>
            </tr>`;

/** Button colors: the sign-in email's green for going ahead, red for stopping or deleting something. */
export const actionColors = { go: '#5fceb3', stop: '#c0392b' };

export const withAction = html.replace('ACTION_ROW', actionRow);
export const withoutAction = html.replace('ACTION_ROW', '');
