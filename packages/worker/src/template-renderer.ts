/**
 * Template rendering engine for deterministic email content.
 *
 * Resolves templates by slug, interpolates variables with HTML escaping,
 * and produces ready-to-send subject + body_html + body_text without any
 * LLM involvement.
 *
 * Variable syntax: {{variable_name}} (double curly braces, no spaces required).
 * Nested properties: {{contact.first_name}}, {{contact.properties.company}}.
 *
 * Security: all interpolated values are HTML-escaped before insertion.
 * A contact named "<script>alert(1)</script>" renders as the escaped entity
 * string, never as executable HTML.
 *
 * Missing variables: if any referenced variable cannot be resolved, the
 * template render FAILS with an explicit error identifying the missing
 * variable(s). This is deliberate: a template is deterministic content
 * authored with specific variables in mind. Rendering with gaps or raw
 * placeholders violates the author's intent and produces unprofessional
 * email. The message is marked 'failed' with a clear reason so the operator
 * can fix the data or the template.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context available for variable resolution during template rendering. */
export interface TemplateContext {
  contact: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    external_id: string;
    properties: Record<string, unknown> | null;
  };
  tenant: {
    name: string;
  };
  flow: {
    name: string;
  };
}

export interface RenderResult {
  ok: true;
  subject: string;
  bodyHtml: string;
  bodyText: string;
}

export interface RenderError {
  ok: false;
  reason: string;
  missingVariables: string[];
}

export type TemplateRenderOutcome = RenderResult | RenderError;

// ---------------------------------------------------------------------------
// Variable set documentation
// ---------------------------------------------------------------------------

/**
 * Supported template variables (exhaustive list):
 *
 *   contact.first_name    - Contact's first name (from properties or dedicated column)
 *   contact.last_name     - Contact's last name (from properties or dedicated column)
 *   contact.email         - Contact's email address
 *   contact.external_id   - External system identifier
 *   contact.properties.*  - Any key from the contact's properties JSONB
 *   tenant.name           - Tenant/company name
 *   flow.name             - Name of the flow that triggered this message
 *
 * Unknown variable paths (e.g. {{foo.bar}}) are treated as missing variables
 * and cause the render to fail.
 */
export const SUPPORTED_VARIABLE_PREFIXES = [
  "contact.first_name",
  "contact.last_name",
  "contact.email",
  "contact.external_id",
  "contact.properties.",
  "tenant.name",
  "flow.name",
] as const;

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

/**
 * Escape HTML special characters to prevent XSS when interpolating
 * user-supplied values into HTML email bodies.
 */
export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ---------------------------------------------------------------------------
// Variable resolution
// ---------------------------------------------------------------------------

/**
 * Regex matching {{variable_name}} or {{variable_name|fallback}} patterns.
 * The pipe-separated fallback is optional. When present, a missing variable
 * uses the fallback text instead of failing the render.
 *
 * Examples:
 *   {{contact.first_name}}           - required, fails if missing
 *   {{contact.first_name|there}}     - optional with fallback "there"
 *   {{ tenant.name | Your Product }} - whitespace around pipe is trimmed
 */
const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

/**
 * Resolve a single variable path against the template context.
 * Returns the string value or null if the variable is missing/unresolvable.
 */
function resolveVariable(path: string, ctx: TemplateContext): string | null {
  const parts = path.split(".");

  if (parts[0] === "contact") {
    if (parts.length < 2) return null;

    switch (parts[1]) {
      case "first_name":
        return ctx.contact.first_name;
      case "last_name":
        return ctx.contact.last_name;
      case "email":
        return ctx.contact.email;
      case "external_id":
        return ctx.contact.external_id;
      case "properties": {
        if (parts.length < 3) return null;
        const propKey = parts.slice(2).join(".");
        if (!ctx.contact.properties) return null;
        const val = ctx.contact.properties[propKey];
        if (val === undefined || val === null) return null;
        return String(val);
      }
      default:
        return null;
    }
  }

  if (parts[0] === "tenant") {
    if (parts[1] === "name") return ctx.tenant.name;
    return null;
  }

  if (parts[0] === "flow") {
    if (parts[1] === "name") return ctx.flow.name;
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Core rendering
// ---------------------------------------------------------------------------

/**
 * Render a template string by interpolating variables from context.
 *
 * @param template - Template string with {{variable}} placeholders.
 * @param ctx - Variable resolution context.
 * @param escapeValues - Whether to HTML-escape interpolated values (true for HTML, false for text/subject).
 * @returns Rendered string and list of any missing variables.
 */
function renderString(
  template: string,
  ctx: TemplateContext,
  escapeValues: boolean,
): { rendered: string; missing: string[] } {
  const missing: string[] = [];

  const rendered = template.replace(VARIABLE_PATTERN, (_match, varPath: string, fallback: string | undefined) => {
    const value = resolveVariable(varPath, ctx);
    if (value === null) {
      // If a pipe-fallback was declared, use it instead of failing
      if (fallback !== undefined) {
        return escapeValues ? escapeHtml(fallback) : fallback;
      }
      missing.push(varPath);
      // Return the original placeholder (will be caught by the missing check)
      return `{{${varPath}}}`;
    }
    return escapeValues ? escapeHtml(value) : value;
  });

  return { rendered, missing };
}

/**
 * Render a complete template (subject + body_html + body_text).
 *
 * If any variable in any part of the template cannot be resolved, the
 * entire render fails with an explicit error listing all missing variables.
 * No partial content is produced.
 *
 * @param subject - Subject line template.
 * @param bodyHtml - HTML body template.
 * @param bodyText - Plain text body template (optional, derived from HTML if absent).
 * @param ctx - Variable resolution context.
 */
export function renderTemplate(
  subject: string,
  bodyHtml: string,
  bodyText: string | null,
  ctx: TemplateContext,
): TemplateRenderOutcome {
  const subjectResult = renderString(subject, ctx, false);
  const htmlResult = renderString(bodyHtml, ctx, true);
  const textResult = bodyText
    ? renderString(bodyText, ctx, false)
    : { rendered: stripHtmlTags(htmlResult.rendered), missing: [] as string[] };

  // Collect all missing variables (deduplicated)
  const allMissing = [
    ...new Set([
      ...subjectResult.missing,
      ...htmlResult.missing,
      ...textResult.missing,
    ]),
  ];

  if (allMissing.length > 0) {
    return {
      ok: false,
      reason: `Template render failed: missing variable(s): ${allMissing.join(", ")}. ` +
        `The contact record does not have values for these fields. ` +
        `Either update the contact data or remove these variables from the template.`,
      missingVariables: allMissing,
    };
  }

  return {
    ok: true,
    subject: subjectResult.rendered,
    bodyHtml: htmlResult.rendered,
    bodyText: textResult.rendered,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Naive HTML tag stripper for deriving plain text from HTML when no
 * explicit body_text template is provided. Not a full HTML parser -
 * sufficient for simple email templates.
 */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
