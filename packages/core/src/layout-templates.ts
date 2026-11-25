/**
 * Email templates (layouts): the HTML document every email of a product is
 * sent in. A template is HTML with placeholders; the message body, the
 * compliance footer and the brand values are filled in at send time.
 *
 * Placeholders ({{name}}, filled in one pass, so text inside the body is
 * never read as a placeholder):
 *
 *   {{body}}               required, once: the message body (HTML)
 *   {{compliance_footer}}  required, once: unsubscribe link and postal address
 *   {{preheader}}          hidden inbox preview text (empty when the step has none)
 *   {{eyebrow}}            the step's small label above the body, as a <p>, or empty
 *   {{logo}}               the logo <img>, or the brand name as text when there is no logo
 *   {{logo_url}}           the logo URL, or empty
 *   {{brand_name}}         the brand name (escaped)
 *   {{accent_color}}       the accent color (hex)
 *   {{accent_soft}}        the accent mixed with white (a light tint, hex)
 *   {{footer_text}}        the footer line ("You are receiving this email because...")
 *
 * Pure logic, no I/O: the stored custom templates are loaded by the caller.
 */
import { esc, safeAccentColor, clampLogoHeight, preheaderHtml, applyWideBodyLayout, type EmailShellInput } from "./email-shell-parts.js";
import { CLASSIC_SOURCE, WIDE_SOURCE, LETTER_SOURCE, BANNER_SOURCE, COMPACT_SOURCE, BROADSHEET_SOURCE, CANVAS_SOURCE } from "./layout-builtins.js";

/** Widths a template is designed for. "wide" also gives body paragraphs a readable measure. */
export const LAYOUT_WIDTHS = ["narrow", "wide"] as const;
export type LayoutWidth = (typeof LAYOUT_WIDTHS)[number];

/** A template ready to render. */
export interface LayoutTemplate {
  source: string;
  width: LayoutWidth;
}

/** Every placeholder a template may use. */
export const LAYOUT_PLACEHOLDERS = [
  "body",
  "compliance_footer",
  "preheader",
  "eyebrow",
  "logo",
  "logo_url",
  "brand_name",
  "accent_color",
  "accent_soft",
  "footer_text",
] as const;
export type LayoutPlaceholder = (typeof LAYOUT_PLACEHOLDERS)[number];

/** Placeholders a template must contain exactly once. */
export const REQUIRED_PLACEHOLDERS: readonly LayoutPlaceholder[] = ["body", "compliance_footer"];

/** Largest template source accepted, in bytes (UTF-8). Gmail clips whole messages over 102 KB. */
export const LAYOUT_MAX_BYTES = 64 * 1024;

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

export interface BuiltinLayout extends LayoutTemplate {
  key: string;
  name: string;
  description: string;
}

/**
 * The templates every product has. "classic" is the narrow layout and
 * "wide" the wide layout that brand.layout selects; their output is pinned
 * byte for byte (tests/fixtures/email-shell).
 */
export const BUILTIN_LAYOUTS: readonly BuiltinLayout[] = [
  {
    key: "classic",
    name: "Classic",
    width: "narrow",
    description: "A centered white card at most 600px wide with an accent bar on top. The default.",
    source: CLASSIC_SOURCE,
  },
  {
    key: "letter",
    name: "Letter",
    width: "narrow",
    description: "No card and no color blocks: a personal note in a serif face, like mail from a founder.",
    source: LETTER_SOURCE,
  },
  {
    key: "banner",
    name: "Banner",
    width: "narrow",
    description: "A tinted header band in the accent color around the logo, then a white card.",
    source: BANNER_SOURCE,
  },
  {
    key: "compact",
    name: "Compact",
    width: "narrow",
    description: "A tight bordered card at most 520px wide for receipts, codes and account notices.",
    source: COMPACT_SOURCE,
  },
  {
    key: "wide",
    name: "Wide",
    width: "wide",
    description: "The card fills the reading pane; paragraphs keep a 680px measure.",
    source: WIDE_SOURCE,
  },
  {
    key: "broadsheet",
    name: "Broadsheet",
    width: "wide",
    description: "Full-width header row with logo and brand name over an accent rule, for updates and newsletters.",
    source: BROADSHEET_SOURCE,
  },
  {
    key: "canvas",
    name: "Canvas",
    width: "wide",
    description: "Edge to edge white, no card and no frame: the body is the design.",
    source: CANVAS_SOURCE,
  },
];

/** The built-in template with this key, or null. */
export function builtinLayout(key: string | null | undefined): BuiltinLayout | null {
  if (!key) return null;
  return BUILTIN_LAYOUTS.find((b) => b.key === key) ?? null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when brand.template names a stored (custom) template rather than a built-in one. */
export function isCustomLayoutRef(ref: unknown): ref is string {
  return typeof ref === "string" && UUID_RE.test(ref);
}

/** Built-in key of the template brand.layout selects when brand.template is unset. */
export function layoutKeyForBrandLayout(layout: unknown): "classic" | "wide" {
  return layout === "wide" ? "wide" : "classic";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Mix a hex color with white; amount 0 = the color, 1 = white. */
export function tintHex(hex: string, amount: number): string {
  let h = hex.replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  h = h.slice(0, 6);
  const out = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16);
    const mixed = Math.round(v + (255 - v) * amount);
    return mixed.toString(16).padStart(2, "0");
  });
  return `#${out.join("")}`;
}

/** The value of every placeholder for one message. */
export function layoutValues(input: EmailShellInput, width: LayoutWidth): Record<LayoutPlaceholder, string> {
  const accent = safeAccentColor(input.brand.accent_color);
  const brandName = esc(input.brand.brand_name || input.tenantName);
  const logoUrl = input.brand.logo_url || "";
  const logoHeight = clampLogoHeight(input.brand.logo_height);
  const footerText = input.brand.footer_text
    ? esc(input.brand.footer_text)
    : `You are receiving this email because you have an account with ${brandName}.`;
  const logo = logoUrl
    ? `<img src="${esc(logoUrl)}" alt="${brandName}" height="${logoHeight}" style="display:block;height:${logoHeight}px;width:auto;border:0;" />`
    : `<span style="font-size:14px;font-weight:600;color:#6b7280;letter-spacing:0.02em;text-transform:uppercase;">${brandName}</span>`;
  const eyebrow = input.eyebrow
    ? `<p class="email-eyebrow" style="margin:0 0 12px 0;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${accent};">${esc(input.eyebrow)}</p>\n`
    : "";
  return {
    body: width === "wide" ? applyWideBodyLayout(input.bodyHtml) : input.bodyHtml,
    compliance_footer: input.complianceFooterHtml,
    preheader: preheaderHtml(input.preheader),
    eyebrow,
    logo,
    logo_url: esc(logoUrl),
    brand_name: brandName,
    accent_color: accent,
    accent_soft: tintHex(accent, 0.88),
    footer_text: footerText,
  };
}

/**
 * Render a template for one message. Unknown placeholders render empty
 * (validateLayoutSource refuses them before a template is stored).
 */
export function renderLayout(template: LayoutTemplate, input: EmailShellInput): string {
  const values = layoutValues(input, template.width);
  return template.source.replace(PLACEHOLDER_RE, (_m, name: string) =>
    (LAYOUT_PLACEHOLDERS as readonly string[]).includes(name) ? values[name as LayoutPlaceholder] : "",
  );
}

/**
 * The template a product sends with: a stored template when one is given
 * (the caller loaded brand.template), else the built-in brand.template
 * names, else the one brand.layout selects.
 */
export function resolveLayout(brand: { template?: unknown; layout?: unknown }, custom?: LayoutTemplate | null): LayoutTemplate {
  if (custom) return custom;
  const named = typeof brand.template === "string" ? builtinLayout(brand.template) : null;
  return named ?? builtinLayout(layoutKeyForBrandLayout(brand.layout))!;
}

// ---------------------------------------------------------------------------
// Sample content for previews
// ---------------------------------------------------------------------------

/** A body in the shape drafted messages have (markdown output), for previews. */
export const SAMPLE_BODY_HTML = [
  '<h2 style="font-size:20px;font-weight:700;margin:0 0 16px 0;line-height:1.3;">Your workspace is ready</h2>',
  '<p style="margin:0 0 16px 0;line-height:1.6;">Hi Ada,</p>',
  '<p style="margin:0 0 16px 0;line-height:1.6;">Thanks for signing up. Three things get most teams to their first result in a day: connect your data source, invite one teammate and pick a starting template. Each takes a few minutes, and you can come back to any of them later.</p>',
  '<ul style="margin:0 0 16px 0;padding-left:24px;">',
  '<li style="margin:0 0 6px 0;line-height:1.5;">Connect a data source</li>',
  '<li style="margin:0 0 6px 0;line-height:1.5;">Invite a teammate</li>',
  '<li style="margin:0 0 6px 0;line-height:1.5;">Pick a starting template</li>',
  "</ul>",
  '<p style="margin:0 0 24px 0;"><a href="https://example.com/start" style="display:inline-block;padding:12px 24px;background:#26282e;color:#f7f7f9;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500;">Open your workspace</a></p>',
  '<p style="margin:0 0 16px 0;line-height:1.6;">Questions? Reply to this email and a person will answer.</p>',
].join("\n");

/** Compliance footer as the drain builds it, with example values. */
export const SAMPLE_COMPLIANCE_HTML =
  '<p style="margin:0 0 4px 0;"><a href="https://example.com/unsubscribe" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a> from these emails.</p>\n<p style="margin:0;">1 Example Street, Springfield</p>';
