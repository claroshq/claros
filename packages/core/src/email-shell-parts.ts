/**
 * Types and helpers shared by the email shell (email-shell.ts) and the
 * template renderer (layout-templates.ts).
 */
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
  /**
   * Absolute URL to the logo's dark-mode version (v0.8.14), shown instead
   * of logo_url when mail is read in dark mode by an app that tells the
   * email (Apple Mail, Outlook). Used only together with logo_url.
   */
  logo_dark_url?: string;
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
  /**
   * The email template: a built-in key ("classic", "wide", ...) or the id
   * of a stored template. Wins over layout when set.
   */
  template?: string;
}

/** Values of brand.layout. */
export const BRAND_LAYOUTS = ["narrow", "wide"] as const;
export type BrandLayout = (typeof BRAND_LAYOUTS)[number];

/**
 * The font of every email. Set inline on <body> AND on every content cell:
 * Outlook desktop (Word renderer) does not inherit a body font into tables
 * and falls back to Times New Roman, and some webmail clients drop the
 * <body> style. The mso-only <style> block pins Arial for Outlook, which
 * does not know the system-font keywords.
 */
export const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

export const MSO_FONT_STYLE = `<!--[if mso]>
<style>
body, table, td, p, a, li, h1, h2, h3, span { font-family: Arial, sans-serif !important; }
</style>
<![endif]-->`;

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
  /**
   * The stored template brand.template names, loaded by the caller. Absent
   * or null: the built-in template brand.template or brand.layout selects.
   */
  layout?: { source: string; width: "narrow" | "wide" } | null;
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
export function clampLogoHeight(h: number | undefined): number {
  if (!h || h < 16) return 32;
  if (h > 64) return 64;
  return Math.round(h);
}

/** Validate hex color, return safe default if invalid. */
export function safeAccentColor(color: string | undefined): string {
  if (!color) return "#2563eb";
  // Accept #RGB, #RRGGBB, #RRGGBBAA
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color)) {
    return color;
  }
  return "#2563eb";
}

/** Escape HTML entities in text that will be placed in attribute or content positions. */
export function esc(s: string): string {
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
export function preheaderHtml(text: string | null | undefined): string {
  if (!text) return "";
  const pad = "&#8204;&nbsp;".repeat(60);
  return `<div class="email-preheader" style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:#f9fafb;">${esc(text)}${pad}</div>\n`;
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
