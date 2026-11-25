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
 *   5. Narrow templates: max-width enforced via an Outlook-specific
 *      <!--[if mso]> ghost table because Outlook ignores max-width CSS.
 *      Wide templates: every table is width="100%", so Outlook needs no
 *      wrapper. The templates themselves live in layout-builtins.ts and,
 *      for custom ones, in the email_layouts table (layout-templates.ts).
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
import { esc, type EmailShellInput, type TextShellInput } from "./email-shell-parts.js";
import { renderLayout, resolveLayout } from "./layout-templates.js";

export {
  BRAND_LAYOUTS,
  TEXT_MEASURE,
  FONT_STACK,
  applyWideBodyLayout,
  type BrandLayout,
  type BrandSettings,
  type EmailShellInput,
  type TextShellInput,
} from "./email-shell-parts.js";

// ---------------------------------------------------------------------------
// HTML Shell
// ---------------------------------------------------------------------------

/**
 * Wrap a body HTML fragment in the product's email template.
 *
 * Returns a complete HTML document (DOCTYPE, <html>, <head>, <body>)
 * ready to be passed to the transport as `bodyHtml`. The template is
 * input.layout (a stored template the caller loaded), else the built-in
 * brand.template names, else "wide" for brand.layout "wide", else
 * "classic" (the narrow layout).
 *
 * Compliance footer is placed inside the shell at the proper position
 * (the template's {{compliance_footer}}). The caller passes the
 * pre-built compliance HTML and this function places it; it does NOT call
 * buildComplianceOutput itself.
 */
export function wrapInShell(input: EmailShellInput): string {
  return renderLayout(resolveLayout(input.brand, input.layout ?? null), input);
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
