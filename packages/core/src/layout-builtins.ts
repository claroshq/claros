/**
 * Sources of the built-in email templates (see layout-templates.ts for the
 * placeholders). CLASSIC_SOURCE and WIDE_SOURCE are the narrow and wide
 * layouts of v0.8.7; their output is pinned byte for byte by
 * tests/fixtures/email-shell. Change them only with a CHANGELOG entry:
 * every product that never chose a template sends with them.
 *
 * Email HTML is not web HTML: tables for structure, inline styles, no
 * flexbox or grid (Outlook for Windows renders with Word), no web fonts,
 * no background images, max-width only inside an Outlook ghost table.
 */

export const CLASSIC_SOURCE = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="x-apple-disable-message-reformatting" />
<title>{{brand_name}}</title>
<!--[if mso]>
<noscript>
<xml>
<o:OfficeDocumentSettings>
<o:AllowPNG/>
<o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings>
</xml>
</noscript>
<![endif]-->
<!--[if mso]>
<style>
body, table, td, p, a, li, h1, h2, h3, span { font-family: Arial, sans-serif !important; }
</style>
<![endif]-->
<style>
/* Reset */
body, table, td, p, a, li { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
body { margin: 0; padding: 0; width: 100% !important; height: 100% !important; }
/* Dark mode overrides for supporting clients */
@media (prefers-color-scheme: dark) {
  .email-body { background-color: #1a1a2e !important; }
  .email-container { background-color: #16213e !important; }
  .email-content { color: #e0e0e0 !important; }
  .email-header-text { color: #e0e0e0 !important; }
  .email-footer { color: #a0a0a0 !important; }
  .email-footer a { color: #a0a0a0 !important; }
}
</style>
</head>
<body class="email-body" style="margin:0;padding:0;background-color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
{{preheader}}<!-- Outlook max-width wrapper -->
<!--[if mso]>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" align="center"><tr><td>
<![endif]-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto;">
<!-- Top accent bar -->
<tr>
<td style="height:4px;background-color:{{accent_color}};font-size:1px;line-height:1px;">&nbsp;</td>
</tr>
<!-- Header: no bottom padding - flows directly into body content -->
<tr>
<td class="email-container" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background-color:#ffffff;padding:28px 40px 0 40px;">
{{logo}}
</td>
</tr>
<!-- Body content -->
<tr>
<td class="email-container email-content" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background-color:#ffffff;padding:24px 40px 40px 40px;font-size:15px;line-height:1.65;color:#1a1a1a;">
{{eyebrow}}{{body}}
</td>
</tr>
<!-- Footer -->
<tr>
<td class="email-container email-footer" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background-color:#f9fafb;padding:20px 40px 24px 40px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#6b7280;">
<p style="margin:0 0 6px 0;">{{footer_text}}</p>
{{compliance_footer}}
</td>
</tr>
</table>
<!--[if mso]>
</td></tr></table>
<![endif]-->
</body>
</html>`;

export const WIDE_SOURCE = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="x-apple-disable-message-reformatting" />
<title>{{brand_name}}</title>
<!--[if mso]>
<noscript>
<xml>
<o:OfficeDocumentSettings>
<o:AllowPNG/>
<o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings>
</xml>
</noscript>
<![endif]-->
<!--[if mso]>
<style>
body, table, td, p, a, li, h1, h2, h3, span { font-family: Arial, sans-serif !important; }
</style>
<![endif]-->
<style>
/* Reset */
body, table, td, p, a, li { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
body { margin: 0; padding: 0; width: 100% !important; height: 100% !important; }
/* Wide layout: narrower side padding and full-width buttons on small screens */
@media only screen and (max-width: 760px) {
  .pad { padding-left: 20px !important; padding-right: 20px !important; }
  .email-button { display: block !important; text-align: center !important; }
}
/* Dark mode overrides for supporting clients */
@media (prefers-color-scheme: dark) {
  .email-body { background-color: #1a1a2e !important; }
  .email-container { background-color: #16213e !important; }
  .email-content { color: #e0e0e0 !important; }
  .email-header-text { color: #e0e0e0 !important; }
  .email-footer { color: #a0a0a0 !important; }
  .email-footer a { color: #a0a0a0 !important; }
}
</style>
</head>
<body class="email-body" style="margin:0;padding:0;background-color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
{{preheader}}<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="email-body" style="width:100%;background-color:#f9fafb;">
<tr>
<td align="center" style="padding:24px 12px 40px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">
<!-- Top accent bar -->
<tr>
<td style="height:4px;background-color:{{accent_color}};font-size:1px;line-height:1px;">&nbsp;</td>
</tr>
<!-- Header: no bottom padding - flows directly into body content -->
<tr>
<td class="email-container pad" align="left" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background-color:#ffffff;padding:28px 40px 0 40px;">
{{logo}}
</td>
</tr>
<!-- Body content -->
<tr>
<td class="email-container email-content pad" align="left" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background-color:#ffffff;padding:24px 40px 40px 40px;font-size:15px;line-height:1.65;color:#1a1a1a;text-align:left;">
{{eyebrow}}{{body}}
</td>
</tr>
<!-- Footer -->
<tr>
<td class="email-container email-footer pad" align="left" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background-color:#f9fafb;padding:20px 40px 24px 40px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#6b7280;text-align:left;">
<p style="margin:0 0 6px 0;">{{footer_text}}</p>
{{compliance_footer}}
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Templates added with the template library. Shared rules: tables for
// structure, inline styles, system font stacks, an Outlook ghost table
// around every max-width (narrow), width="100%" tables only (wide), a
// prefers-color-scheme block for the clients that honour it, and nothing
// that breaks when <style> is stripped.
// ---------------------------------------------------------------------------

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

const headOpen = (msoFont: string) => `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="x-apple-disable-message-reformatting" />
<title>{{brand_name}}</title>
<!--[if mso]>
<noscript>
<xml>
<o:OfficeDocumentSettings>
<o:AllowPNG/>
<o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings>
</xml>
</noscript>
<![endif]-->
<!--[if mso]>
<style>
body, table, td, p, a, li, h1, h2, h3, span { font-family: ${msoFont} !important; }
</style>
<![endif]-->
<style>
/* Reset */
body, table, td, p, a, li { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
body { margin: 0; padding: 0; width: 100% !important; height: 100% !important; }`;


export const LETTER_SOURCE = `${headOpen("Georgia, serif")}
@media only screen and (max-width: 600px) {
  .pad { padding-left: 24px !important; padding-right: 24px !important; }
}
@media (prefers-color-scheme: dark) {
  .email-body { background-color: #161616 !important; }
  .email-content { color: #e6e6e6 !important; }
  .email-rule { background-color: #333333 !important; }
  .email-footer { color: #9a9a9a !important; }
  .email-footer a { color: #9a9a9a !important; }
}
</style>
</head>
<body class="email-body" style="margin:0;padding:0;background-color:#ffffff;font-family:${SANS};">
{{preheader}}<!--[if mso]>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" align="center"><tr><td>
<![endif]-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;">
<tr>
<td class="pad" style="font-family:${SANS};padding:40px 32px 0 32px;">
{{logo}}
</td>
</tr>
<tr>
<td class="pad email-content" style="padding:28px 32px 32px 32px;font-family:Georgia,'Times New Roman',Times,serif;font-size:17px;line-height:1.7;color:#222222;">
{{eyebrow}}{{body}}
</td>
</tr>
<tr>
<td class="pad" style="font-family:${SANS};padding:0 32px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td class="email-rule" style="font-family:${SANS};height:1px;font-size:1px;line-height:1px;background-color:#e5e5e5;">&nbsp;</td></tr></table>
</td>
</tr>
<tr>
<td class="pad email-footer" style="font-family:${SANS};padding:20px 32px 40px 32px;font-size:12px;line-height:1.6;color:#777777;">
<p style="margin:0 0 6px 0;">{{footer_text}}</p>
{{compliance_footer}}
</td>
</tr>
</table>
<!--[if mso]>
</td></tr></table>
<![endif]-->
</body>
</html>`;

export const BANNER_SOURCE = `${headOpen("Arial, sans-serif")}
@media only screen and (max-width: 640px) {
  .pad { padding-left: 24px !important; padding-right: 24px !important; }
}
@media (prefers-color-scheme: dark) {
  .email-body { background-color: #111827 !important; }
  .email-container { background-color: #1f2937 !important; }
  .email-content { color: #e5e7eb !important; }
  .email-footer { color: #9ca3af !important; }
  .email-footer a { color: #9ca3af !important; }
}
</style>
</head>
<body class="email-body" style="margin:0;padding:0;background-color:#f3f4f6;font-family:${SANS};">
{{preheader}}<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="email-body" bgcolor="#f3f4f6" style="background-color:#f3f4f6;">
<tr>
<td align="center" style="padding:32px 12px 40px 12px;">
<!--[if mso]>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" align="center"><tr><td>
<![endif]-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto;">
<tr>
<td class="pad" align="left" bgcolor="{{accent_soft}}" style="font-family:${SANS};background-color:{{accent_soft}};padding:32px 40px;border-radius:12px 12px 0 0;">
{{logo}}
</td>
</tr>
<tr>
<td class="pad email-container email-content" align="left" bgcolor="#ffffff" style="font-family:${SANS};background-color:#ffffff;padding:36px 40px 40px 40px;font-size:15px;line-height:1.65;color:#1a1a1a;border-radius:0 0 12px 12px;">
{{eyebrow}}{{body}}
</td>
</tr>
<tr>
<td class="pad email-footer" align="center" style="font-family:${SANS};padding:24px 40px 0 40px;font-size:12px;line-height:1.6;color:#6b7280;text-align:center;">
<p style="margin:0 0 6px 0;">{{footer_text}}</p>
{{compliance_footer}}
</td>
</tr>
</table>
<!--[if mso]>
</td></tr></table>
<![endif]-->
</td>
</tr>
</table>
</body>
</html>`;

export const COMPACT_SOURCE = `${headOpen("Arial, sans-serif")}
@media only screen and (max-width: 560px) {
  .pad { padding-left: 20px !important; padding-right: 20px !important; }
}
@media (prefers-color-scheme: dark) {
  .email-body { background-color: #111111 !important; }
  .email-container { background-color: #1c1c1c !important; border-color: #333333 !important; }
  .email-content { color: #e5e5e5 !important; }
  .email-rule { background-color: #333333 !important; }
  .email-footer { color: #9a9a9a !important; }
  .email-footer a { color: #9a9a9a !important; }
}
</style>
</head>
<body class="email-body" style="margin:0;padding:0;background-color:#f9fafb;font-family:${SANS};">
{{preheader}}<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="email-body" bgcolor="#f9fafb" style="background-color:#f9fafb;">
<tr>
<td align="center" style="padding:32px 12px;">
<!--[if mso]>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="520" align="center"><tr><td>
<![endif]-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="email-container" bgcolor="#ffffff" style="max-width:520px;margin:0 auto;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">
<tr>
<td class="pad" align="left" style="font-family:${SANS};padding:20px 28px;">
{{logo}}
</td>
</tr>
<tr>
<td style="padding:0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td class="email-rule" style="font-family:${SANS};height:1px;font-size:1px;line-height:1px;background-color:#e5e7eb;">&nbsp;</td></tr></table>
</td>
</tr>
<tr>
<td class="pad email-content" align="left" style="font-family:${SANS};padding:24px 28px 28px 28px;font-size:14px;line-height:1.6;color:#1a1a1a;">
{{eyebrow}}{{body}}
</td>
</tr>
</table>
<!--[if mso]>
</td></tr></table>
<![endif]-->
<!--[if mso]>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="520" align="center"><tr><td>
<![endif]-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;margin:0 auto;">
<tr>
<td class="pad email-footer" align="center" style="font-family:${SANS};padding:20px 28px 0 28px;font-size:11px;line-height:1.6;color:#6b7280;text-align:center;">
<p style="margin:0 0 6px 0;">{{footer_text}}</p>
{{compliance_footer}}
</td>
</tr>
</table>
<!--[if mso]>
</td></tr></table>
<![endif]-->
</td>
</tr>
</table>
</body>
</html>`;

export const BROADSHEET_SOURCE = `${headOpen("Arial, sans-serif")}
@media only screen and (max-width: 760px) {
  .pad { padding-left: 20px !important; padding-right: 20px !important; }
  .email-button { display: block !important; text-align: center !important; }
}
@media (prefers-color-scheme: dark) {
  .email-body { background-color: #0f172a !important; }
  .email-container { background-color: #111827 !important; }
  .email-content { color: #e5e7eb !important; }
  .email-footer { background-color: #0f172a !important; color: #94a3b8 !important; }
  .email-footer a { color: #94a3b8 !important; }
}
</style>
</head>
<body class="email-body" style="margin:0;padding:0;background-color:#f1f5f9;font-family:${SANS};">
{{preheader}}<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="email-body" bgcolor="#f1f5f9" style="width:100%;background-color:#f1f5f9;">
<tr>
<td align="center" style="padding:24px 12px 40px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">
<tr>
<td class="email-container pad" align="left" bgcolor="#ffffff" style="font-family:${SANS};background-color:#ffffff;padding:28px 48px 24px 48px;">
{{logo}}
</td>
</tr>
<tr>
<td style="height:3px;background-color:{{accent_color}};font-size:1px;line-height:1px;">&nbsp;</td>
</tr>
<tr>
<td class="email-container email-content pad" align="left" bgcolor="#ffffff" style="font-family:${SANS};background-color:#ffffff;padding:40px 48px 48px 48px;font-size:16px;line-height:1.7;color:#0f172a;text-align:left;">
{{eyebrow}}{{body}}
</td>
</tr>
<tr>
<td class="email-footer pad" align="left" bgcolor="#e2e8f0" style="font-family:${SANS};background-color:#e2e8f0;padding:24px 48px 28px 48px;font-size:12px;line-height:1.6;color:#475569;text-align:left;">
<p style="margin:0 0 6px 0;">{{footer_text}}</p>
{{compliance_footer}}
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;

export const CANVAS_SOURCE = `${headOpen("Arial, sans-serif")}
@media only screen and (max-width: 760px) {
  .pad { padding-left: 20px !important; padding-right: 20px !important; }
  .email-button { display: block !important; text-align: center !important; }
}
@media (prefers-color-scheme: dark) {
  .email-body { background-color: #121212 !important; }
  .email-content { color: #e6e6e6 !important; }
  .email-rule { background-color: #2e2e2e !important; }
  .email-footer { color: #9a9a9a !important; }
  .email-footer a { color: #9a9a9a !important; }
}
</style>
</head>
<body class="email-body" style="margin:0;padding:0;background-color:#ffffff;font-family:${SANS};">
{{preheader}}<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="email-body" bgcolor="#ffffff" style="width:100%;background-color:#ffffff;">
<tr>
<td class="pad" align="left" style="font-family:${SANS};padding:40px 48px 0 48px;">
{{logo}}
</td>
</tr>
<tr>
<td class="pad email-content" align="left" style="font-family:${SANS};padding:32px 48px 40px 48px;font-size:16px;line-height:1.7;color:#111111;text-align:left;">
{{eyebrow}}{{body}}
</td>
</tr>
<tr>
<td class="pad" style="font-family:${SANS};padding:0 48px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td class="email-rule" style="font-family:${SANS};height:1px;font-size:1px;line-height:1px;background-color:#eeeeee;">&nbsp;</td></tr></table>
</td>
</tr>
<tr>
<td class="pad email-footer" align="left" style="font-family:${SANS};padding:20px 48px 48px 48px;font-size:12px;line-height:1.6;color:#777777;text-align:left;">
<p style="margin:0 0 6px 0;">{{footer_text}}</p>
{{compliance_footer}}
</td>
</tr>
</table>
</body>
</html>`;
