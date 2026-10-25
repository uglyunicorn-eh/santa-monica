// A plain layout for short account emails. Placeholders: {{title}}, {{body}}, {{action}}, {{url}}, {{footer}},
// {{assetsUrl}}, {{assetsVersion}}. Values are filled by render(), which HTML-escapes them in the HTML part.
export const html = `<!DOCTYPE html>
<html>
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
  </head>
  <body style="margin:0; padding:0; background-color:#e7ebec; font-family:trebuchet ms,helvetica,sans-serif; color:#000000;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#e7ebec">
      <tr>
        <td align="center" style="padding:20px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
            <tr>
              <td align="center" style="padding-bottom:10px;">
                <img src="{{assetsUrl}}/email/gnomik.png?v={{assetsVersion}}" width="160" alt="" style="display:block; width:160px; height:auto;">
              </td>
            </tr>
            <tr>
              <td style="padding:10px 0; font-size:22px; font-weight:bold;">{{title}}</td>
            </tr>
            <tr>
              <td style="padding:0 0 20px; font-size:16px; line-height:22px;">{{body}}</td>
            </tr>
            ACTION_ROW
            <tr>
              <td style="padding:10px 0 0; font-size:14px; line-height:20px; color:#555555;">{{footer}}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;

const actionRow = `<tr>
              <td align="center" style="padding:10px 0 30px;">
                <a href="{{url}}" style="display:inline-block; padding:12px 24px; background-color:#c0392b; color:#ffffff; font-size:16px; text-decoration:none; border-radius:6px;">{{action}}</a>
              </td>
            </tr>`;

export const withAction = html.replace('ACTION_ROW', actionRow);
export const withoutAction = html.replace('ACTION_ROW', '');
