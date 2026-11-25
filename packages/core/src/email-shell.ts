/**
 * Email branding shell - wraps every outgoing email body in a branded layout.
 *
 * Design constraints (email HTML is not web HTML):
 *
 *   1. Table layout throughout. Flexbox and grid do not work in Outlook
 *      (any version) or older Gmail renderers. Every structural element
 *      is a <table> with role="presentation".
 *   2. All styles inlined. No <style> block relied upon for structure
 *      (Gmail strips <style> in non-AMP contexts; some mobile clients
 *      do the same). A <style> block IS included for dark-mode @media
 *      queries in clients that support it (Apple Mail, iOS Mail,
 *      Outlook.com) but nothing breaks if it is stripped.
 *   3. No external stylesheet, no JavaScript, no form elements.
 *   4. Images referenced by URL only (no CID, no base64 data URIs - they
 *      are blocked or clipped by most providers at scale).
 *   5. Narrow layout (default): max-width enforced via Outlook-specific
 *      <!--[if mso]> wrapper (VML or table) because Outlook ignores
 *      max-width CSS. Wide layout (brand.layout "wide"): every table is
 *      width="100%", so Outlook needs no wrapper; see wrapInWideShell.
 *   6. Font stack falls back to system fonts. No @font-face (not
 *      supported in Gmail, Outlook, or Yahoo).
 *   7. The plain-text alternative is generated separately from the
 *      markdown/text source - never derived by stripping HTML tags from
 *      this shell.
 *
 * Dark mode strategy:
 *   - Background is off-white (#f9fafb), not pure white. Text is near-black
 *     (#1a1a1a), not #000. This palette survives forced dark-mode inversion
 *     (which inverts pure white to pure black and vice versa) without
 *     becoming unreadable.
 *   - An optional @media (prefers-color-scheme: dark) block inside a <style>
 *     tag provides explicit dark colors for clients that support it (Apple
 *     Mail, iOS, Outlook.com). Gmail and Outlook desktop ignore it but
 *     either do not invert (Outlook desktop) or apply their own inversion
 *     that our mid-range palette survives.
 *   - We do NOT set meta color-scheme because that causes some clients to
 *     apply aggressive inversion before our @media block can override.
 *
 * What we deliberately do NOT support:
 *   - Outlook 2003-2007 VML backgrounds (no background-image in the shell)
 *   - Right-to-left layout (can be added per-tenant later)
 *   - Custom fonts (not viable in email without degraded rendering)
 *   - Interactive elements (accordion, carousel, AMP)
 *   - Full-bleed hero images in the shell (body content can include images)
 */
import { publicStrings } from "./i18n.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Brand settings as stored in tenants.settings.brand.
 * Every field is optional; the shell produces a clean email with all defaults.
 */
export interface BrandSettings {
  /** Display name for the brand. Falls back to tenant.name. */
  brand_name?: string;
  /** Absolute URL to logo image. If absent, the brand name is shown as text. */
  logo_url?: string;
  /** Logo height in px. Default 32. Max 64. */
  logo_height?: number;
  /** Hex color for the accent bar and link color. Default "#2563eb" (blue-600). */
  accent_color?: string;
  /** Custom footer text (replaces default "You are receiving this..."). */
  footer_text?: string;
  /** Reply-to address. If absent, reply goes to from_email. */
  reply_to?: string;
  /**
   * Card layout. "narrow" (default, also any other value): a centered card
   * at most 600px wide. "wide": the card fills the reading pane and only
   * running text keeps a readable measure (TEXT_MEASURE).
   */
  layout?: BrandLayout;
}

/** Values of brand.layout. */
export const BRAND_LAYOUTS = ["narrow", "wide"] as const;
export type BrandLayout = (typeof BRAND_LAYOUTS)[number];

/** Widest a paragraph renders in the wide layout, in CSS pixels. */
export const TEXT_MEASURE = 680;

/**
 * Input to the shell renderer. Assembled at drain time from the message row
 * and tenant settings.
 */
export interface EmailShellInput {
  /** The rendered body content (HTML fragment, not a full document). */
  bodyHtml: string;
  /** Brand settings from tenant. All fields optional. */
  brand: BrandSettings;
  /** Tenant name (used as fallback for brand_name). */
  tenantName: string;
  /** Pre-built compliance footer HTML (unsubscribe link + postal address). */
  complianceFooterHtml: string;
  /** P5b: small label above the body (the step's eyebrow). */
  eyebrow?: string | null;
  /** P5b: hidden preheader (inbox preview text). */
  preheader?: string | null;
}

/**
 * Input for plain-text shell wrapping.
 */
export interface TextShellInput {
  /** The rendered body content (plain text). */
  bodyText: string;
  /** Brand settings from tenant. */
  brand: BrandSettings;
  /** Tenant name (used as fallback for brand_name). */
  tenantName: string;
  /** Pre-built compliance footer (plain text). */
  complianceFooterText: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clamp logo height to a safe range. */
function clampLogoHeight(h: number | undefined): number {
  if (!h || h < 16) return 32;
  if (h > 64) return 64;
  return Math.round(h);
}

/** Validate hex color, return safe default if invalid. */
function safeAccentColor(color: string | undefined): string {
  if (!color) return "#2563eb";
  // Accept #RGB, #RRGGBB, #RRGGBBAA
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color)) {
    return color;
  }
  return "#2563eb";
}

/** Escape HTML entities in text that will be placed in attribute or content positions. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Hidden preheader: the inbox preview text. Padded with zero-width
 * non-joiners so the preview does not run on into the body text.
 */
function preheaderHtml(text: string | null | undefined): string {
  if (!text) return "";
  const pad = "&#8204;&nbsp;".repeat(60);
  return `<div class="email-preheader" style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:#f9fafb;">${esc(text)}${pad}</div>\n`;
}

// ---------------------------------------------------------------------------
// HTML Shell
// ---------------------------------------------------------------------------

/**
 * Wrap a body HTML fragment in the full branded email shell.
 *
 * Returns a complete HTML document (DOCTYPE, <html>, <head>, <body>)
 * ready to be passed to the transport as `bodyHtml`.
 *
 * Compliance footer is placed inside the shell at the proper position
 * (bottom of the content area, inside the layout). The caller passes the
 * pre-built compliance HTML and this function places it; it does NOT call
 * buildComplianceOutput itself.
 */
export function wrapInShell(input: EmailShellInput): string {
  return input.brand.layout === "wide" ? wrapInWideShell(input) : wrapInNarrowShell(input);
}

/**
 * The narrow layout (the default): a centered card, max-width 600px, with
 * an Outlook ghost table. Its output must not change; existing products
 * render with it (tests/fixtures/email-shell pins it byte for byte).
 */
function wrapInNarrowShell(input: EmailShellInput): string {
  const accent = safeAccentColor(input.brand.accent_color);
  const brandName = esc(input.brand.brand_name || input.tenantName);
  const logoUrl = input.brand.logo_url || "";
  const logoHeight = clampLogoHeight(input.brand.logo_height);
  const footerText = input.brand.footer_text
    ? esc(input.brand.footer_text)
    : `You are receiving this email because you have an account with ${brandName}.`;

  // Logo or text header
  const headerContent = logoUrl
    ? `<img src="${esc(logoUrl)}" alt="${brandName}" height="${logoHeight}" style="display:block;height:${logoHeight}px;width:auto;border:0;" />`
    : `<span style="font-size:14px;font-weight:600;color:#6b7280;letter-spacing:0.02em;text-transform:uppercase;">${brandName}</span>`;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="x-apple-disable-message-reformatting" />
<title>${brandName}</title>
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
${preheaderHtml(input.preheader)}<!-- Outlook max-width wrapper -->
<!--[if mso]>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" align="center"><tr><td>
<![endif]-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto;">
<!-- Top accent bar -->
<tr>
<td style="height:4px;background-color:${accent};font-size:1px;line-height:1px;">&nbsp;</td>
</tr>
<!-- Header: no bottom padding - flows directly into body content -->
<tr>
<td class="email-container" style="background-color:#ffffff;padding:28px 40px 0 40px;">
${headerContent}
</td>
</tr>
<!-- Body content -->
<tr>
<td class="email-container email-content" style="background-color:#ffffff;padding:24px 40px 40px 40px;font-size:15px;line-height:1.65;color:#1a1a1a;">
${input.eyebrow ? `<p class="email-eyebrow" style="margin:0 0 12px 0;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${accent};">${esc(input.eyebrow)}</p>\n` : ""}${input.bodyHtml}
</td>
</tr>
<!-- Footer -->
<tr>
<td class="email-container email-footer" style="background-color:#f9fafb;padding:20px 40px 24px 40px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#6b7280;">
<p style="margin:0 0 6px 0;">${footerText}</p>
${input.complianceFooterHtml}
</td>
</tr>
</table>
<!--[if mso]>
</td></tr></table>
<![endif]-->
</body>
</html>`;
}

/**
 * Wide-layout body: every paragraph gets an inline max-width (the measure
 * survives clients that strip <style>), and every inline-block link (the
 * button convention of the transactional emails) gets the email-button
 * class so it can become a full-width block on small screens.
 */
export function applyWideBodyLayout(bodyHtml: string): string {
  const measure = `max-width:${TEXT_MEASURE}px;`;
  return bodyHtml
    .replace(/<p(\s[^>]*)?>/g, (_tag, attrs: string | undefined) => {
      const a = attrs ?? "";
      if (/\sstyle="/.test(a)) {
        return `<p${a.replace(/\sstyle="([^"]*)"/, (_m, css: string) => ` style="${css}${css === "" || css.endsWith(";") ? "" : ";"}${measure}"`)}>`;
      }
      return `<p${a} style="${measure}">`;
    })
    .replace(/<a(\s[^>]*)>/g, (tag, attrs: string) => {
      if (/\sclass=/.test(attrs) || !/\sstyle="[^"]*display:\s*inline-block/.test(attrs)) return tag;
      return `<a class="email-button"${attrs}>`;
    });
}

/**
 * The wide layout (brand.layout "wide"): the card is width 100% with no
 * max-width, on a page background with a small gutter. Paragraphs keep a
 * readable measure; lists, tables, buttons and the footer use the full
 * width. Content padding is 40px on the sides, 20px under 760px (.pad).
 * Outlook needs no ghost table: every table is width="100%".
 */
function wrapInWideShell(input: EmailShellInput): string {
  const accent = safeAccentColor(input.brand.accent_color);
  const brandName = esc(input.brand.brand_name || input.tenantName);
  const logoUrl = input.brand.logo_url || "";
  const logoHeight = clampLogoHeight(input.brand.logo_height);
  const footerText = input.brand.footer_text
    ? esc(input.brand.footer_text)
    : `You are receiving this email because you have an account with ${brandName}.`;

  const headerContent = logoUrl
    ? `<img src="${esc(logoUrl)}" alt="${brandName}" height="${logoHeight}" style="display:block;height:${logoHeight}px;width:auto;border:0;" />`
    : `<span style="font-size:14px;font-weight:600;color:#6b7280;letter-spacing:0.02em;text-transform:uppercase;">${brandName}</span>`;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="x-apple-disable-message-reformatting" />
<title>${brandName}</title>
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
${preheaderHtml(input.preheader)}<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="email-body" style="width:100%;background-color:#f9fafb;">
<tr>
<td align="center" style="padding:24px 12px 40px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">
<!-- Top accent bar -->
<tr>
<td style="height:4px;background-color:${accent};font-size:1px;line-height:1px;">&nbsp;</td>
</tr>
<!-- Header: no bottom padding - flows directly into body content -->
<tr>
<td class="email-container pad" align="left" style="background-color:#ffffff;padding:28px 40px 0 40px;">
${headerContent}
</td>
</tr>
<!-- Body content -->
<tr>
<td class="email-container email-content pad" align="left" style="background-color:#ffffff;padding:24px 40px 40px 40px;font-size:15px;line-height:1.65;color:#1a1a1a;text-align:left;">
${input.eyebrow ? `<p class="email-eyebrow" style="margin:0 0 12px 0;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${accent};">${esc(input.eyebrow)}</p>\n` : ""}${applyWideBodyLayout(input.bodyHtml)}
</td>
</tr>
<!-- Footer -->
<tr>
<td class="email-container email-footer pad" align="left" style="background-color:#f9fafb;padding:20px 40px 24px 40px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#6b7280;text-align:left;">
<p style="margin:0 0 6px 0;">${footerText}</p>
${input.complianceFooterHtml}
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Plain-text Shell
// ---------------------------------------------------------------------------

/**
 * Wrap plain text body in a simple branded text shell.
 *
 * Plain-text emails benefit from a minimal header (brand name) and a clean
 * footer separator. The compliance text is appended at the bottom.
 */
export function wrapInTextShell(input: TextShellInput): string {
  const brandName = input.brand.brand_name || input.tenantName;
  const footerText = input.brand.footer_text
    || `You are receiving this email because you have an account with ${brandName}.`;

  const parts: string[] = [];
  parts.push(input.bodyText);
  parts.push("");
  parts.push("---");
  parts.push(footerText);
  parts.push(input.complianceFooterText);

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Compliance footer (shell-aware version)
// ---------------------------------------------------------------------------

/**
 * Build the compliance HTML fragment for placement inside the shell footer.
 *
 * This is a stripped version of the old compliance.htmlFooter - no outer div,
 * no border-top (the shell handles that), just the link and address lines.
 */
export function buildShellComplianceHtml(unsubscribeUrl: string, postalAddress: string, locale?: string | null): string {
  const t = publicStrings(locale);
  return [
    `<p style="margin:0 0 4px 0;"><a href="${esc(unsubscribeUrl)}" style="color:#6b7280;text-decoration:underline;">${esc(t.footerUnsubscribeLink)}</a>${esc(t.footerUnsubscribeRest)}</p>`,
    `<p style="margin:0;">${esc(postalAddress)}</p>`,
  ].join("\n");
}

/**
 * Build the compliance plain-text fragment for placement inside the text shell footer.
 *
 * No leading separator - the text shell handles that.
 */
export function buildShellComplianceText(unsubscribeUrl: string, postalAddress: string, locale?: string | null): string {
  return [
    `${publicStrings(locale).footerTextUnsubscribe}: ${unsubscribeUrl}`,
    postalAddress,
  ].join("\n");
}
