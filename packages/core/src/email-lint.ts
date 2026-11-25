/**
 * Email template checks: what stops a template from being stored (errors)
 * and what mail clients will render differently (warnings, notes).
 *
 * The client knowledge here is deliberately conservative and coarse: it
 * names the clients where a construct is known to fail, not every client
 * where it works. The template studio's model receives the same findings,
 * so its advice and this list never disagree. Pure logic, no I/O; pattern
 * matching on the source, not a full HTML parser.
 */
import { LAYOUT_MAX_BYTES, LAYOUT_PLACEHOLDERS, REQUIRED_PLACEHOLDERS } from "./layout-templates.js";

export type LintSeverity = "error" | "warning" | "info";

export interface LintIssue {
  /** Stable identifier of the check. */
  rule: string;
  severity: LintSeverity;
  /** What is wrong, in one sentence. */
  message: string;
  /** Mail clients affected (empty for checks that are not client specific). */
  clients: string[];
  /** How to fix it. */
  fix: string;
}

const OUTLOOK_WIN = "Outlook for Windows";
const GMAIL = "Gmail";
const GMAIL_NON_GOOGLE = "Gmail apps with non-Google accounts";
const YAHOO = "Yahoo Mail";
const OUTLOOK_COM = "Outlook.com";

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;

function count(source: string, re: RegExp): number {
  return [...source.matchAll(re)].length;
}

/** Byte length of a string in UTF-8. */
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** The source with HTML comments removed, except Outlook conditional comments' content. */
function withoutPlainComments(source: string): string {
  return source.replace(/<!--(?!\[if)[\s\S]*?-->/g, "");
}

/** Style text of the document: <style> blocks plus every inline style attribute. */
function styleText(source: string): string {
  const blocks = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const inline = [...source.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
  const inlineSingle = [...source.matchAll(/\sstyle\s*=\s*'([^']*)'/gi)].map((m) => m[1]);
  return [...blocks, ...inline, ...inlineSingle].join("\n");
}

/**
 * Checks that stop a template from being saved: missing or repeated
 * required placeholders, unknown placeholders, size, and markup that is
 * unsafe or that every client strips (scripts, event handlers, forms,
 * frames, embedded objects).
 */
export function validateLayoutSource(source: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const err = (rule: string, message: string, fix: string, clients: string[] = []) =>
    issues.push({ rule, severity: "error", message, clients, fix });

  if (source.trim() === "") {
    err("empty", "The template is empty.", "Start from a built-in template.");
    return issues;
  }
  if (utf8Bytes(source) > LAYOUT_MAX_BYTES) {
    err("too_large", `The template is larger than ${LAYOUT_MAX_BYTES / 1024} KB.`, "Remove unused styles and markup; Gmail clips whole messages over 102 KB.");
  }
  if (!/<html[\s>]/i.test(source) || !/<body[\s>]/i.test(source)) {
    err("not_a_document", "The template must be a full HTML document with <html> and <body>.", "Keep the document structure of the built-in templates.");
  }
  for (const name of REQUIRED_PLACEHOLDERS) {
    const n = count(source, new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, "g"));
    if (n === 0) err(`missing_${name}`, `The template has no {{${name}}}.`, name === "body" ? "Place {{body}} where the message text goes." : "Place {{compliance_footer}} in the footer: every email must carry the unsubscribe link and postal address.");
    if (n > 1) err(`repeated_${name}`, `{{${name}}} appears ${n} times; it must appear once.`, `Keep one {{${name}}}.`);
  }
  const unknown = new Set<string>();
  for (const m of source.matchAll(PLACEHOLDER_RE)) {
    if (!(LAYOUT_PLACEHOLDERS as readonly string[]).includes(m[1]!)) unknown.add(m[1]!);
  }
  if (unknown.size > 0) {
    err("unknown_placeholder", `Unknown placeholder${unknown.size > 1 ? "s" : ""}: ${[...unknown].map((u) => `{{${u}}}`).join(", ")}.`, `Use only: ${LAYOUT_PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")}. Contact merge variables belong in the message body, not the template.`);
  }

  const markup = withoutPlainComments(source);
  if (/<script\b/i.test(markup)) err("script", "The template contains <script>.", "Remove it: every mail client strips scripts, and some providers mark such mail as spam.", [GMAIL, OUTLOOK_WIN, "Apple Mail", YAHOO]);
  if (/\son[a-z]+\s*=/i.test(markup)) err("event_handler", "The template has an inline event handler (onclick, onload, ...).", "Remove it: mail clients do not run JavaScript.");
  if (/(?:href|src)\s*=\s*["']?\s*javascript:/i.test(markup)) err("javascript_url", "The template has a javascript: link.", "Use an https link.");
  if (/<form\b|<input\b|<select\b|<textarea\b/i.test(markup)) err("form", "The template contains a form or form field.", "Link to a page with the form instead; Gmail and Outlook disable forms in mail.", [GMAIL, OUTLOOK_WIN, OUTLOOK_COM]);
  if (/<(?:iframe|object|embed|frame|frameset)\b/i.test(markup)) err("embedded_content", "The template embeds a frame or object.", "Remove it; no major mail client renders embedded pages. Use an image that links to the page.", [GMAIL, OUTLOOK_WIN, "Apple Mail", YAHOO]);
  if (/<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(markup)) err("meta_refresh", "The template has a meta refresh.", "Remove it.");
  if (/<base\b/i.test(markup)) err("base_tag", "The template has a <base> tag.", "Remove it and use absolute URLs; clients handle <base> inconsistently and it can break the unsubscribe link.");
  return issues;
}

/**
 * Rendering checks: constructs that some clients ignore or render
 * differently. Never blocks a save.
 */
export function lintLayoutSource(source: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (severity: Exclude<LintSeverity, "error">, rule: string, message: string, clients: string[], fix: string) =>
    issues.push({ rule, severity, message, clients, fix });
  const markup = withoutPlainComments(source);
  const css = styleText(markup);

  if (/display\s*:\s*(?:inline-)?flex\b/i.test(css)) {
    add("warning", "flexbox", "Flexbox layout (display:flex) is ignored, so items stack or collapse.", [OUTLOOK_WIN, GMAIL_NON_GOOGLE], "Use a table with one cell per column.");
  }
  if (/display\s*:\s*(?:inline-)?grid\b/i.test(css)) {
    add("warning", "grid", "CSS grid (display:grid) is not supported.", [OUTLOOK_WIN, GMAIL, YAHOO], "Use a table with one cell per column.");
  }
  if (/position\s*:\s*(?:absolute|fixed|relative|sticky)/i.test(css)) {
    add("warning", "position", "CSS positioning is stripped, so overlapping elements fall into the normal flow.", [GMAIL, OUTLOOK_WIN, OUTLOOK_COM], "Lay elements out in table cells; for text over an image, use a background color instead.");
  }
  if (/background(?:-image)?\s*:[^;"']*url\(/i.test(css) || /<(?:td|table|body|div)\b[^>]*\sbackground\s*=/i.test(markup)) {
    add("warning", "background_image", "Background images do not show without VML.", [OUTLOOK_WIN], "Set a solid background color as the fallback, or add a VML <v:rect> fill inside an <!--[if mso]> block.");
  }
  if (/<svg\b/i.test(markup) || /<img\b[^>]*\ssrc\s*=\s*["'][^"']*\.svg(?:[?#][^"']*)?["']/i.test(markup)) {
    add("warning", "svg", "SVG images are not displayed.", [GMAIL, OUTLOOK_WIN, YAHOO], "Use PNG or JPEG (the uploaded brand logo is PNG or JPEG).");
  }
  if (/@font-face|@import|fonts\.googleapis\.com|<link\b[^>]*stylesheet/i.test(markup)) {
    add("warning", "web_font", "Web fonts and external stylesheets are not loaded; text falls back to the next font in the stack.", [GMAIL, OUTLOOK_WIN, YAHOO], "Keep a system font stack (for example -apple-system, 'Segoe UI', Roboto, Arial, sans-serif) after any web font.");
  }
  if (/var\(--/i.test(css)) {
    add("warning", "css_variables", "CSS custom properties (var(--...)) are not supported, so those colors and sizes are dropped.", [GMAIL, OUTLOOK_WIN, YAHOO], "Write the values out.");
  }
  const maxWidthOnContainer = /<(?:table|div|td)\b[^>]*style\s*=\s*["'][^"']*max-width\s*:/i.test(markup);
  if (maxWidthOnContainer && !/<!--\[if mso/i.test(source)) {
    add("warning", "max_width_without_ghost_table", "max-width on a container is ignored, so the email stretches across the whole reading pane.", [OUTLOOK_WIN], 'Wrap the container in an Outlook ghost table: <!--[if mso]><table width="600" align="center"><tr><td><![endif]--> ... <!--[if mso]></td></tr></table><![endif]-->.');
  }
  const wide = [...markup.matchAll(/<(?:table|td|img)\b[^>]*\swidth\s*=\s*["']?(\d+)["']?/gi)].map((m) => Number(m[1])).filter((w) => w > 700);
  if (wide.length > 0) {
    add("warning", "fixed_width", `A fixed width of ${Math.max(...wide)}px is wider than most phone screens and reading panes.`, ["Apple Mail on iPhone", "Gmail app"], 'Use width="100%" with a max-width (plus an Outlook ghost table), or at most 600 to 640px.');
  }
  if (/<(?:video|audio)\b/i.test(markup)) {
    add("warning", "media", "Video and audio elements do not play.", [GMAIL, OUTLOOK_WIN, YAHOO], "Use a still image that links to the video page.");
  }
  if (/<img\b[^>]*\ssrc\s*=\s*["']data:/i.test(markup)) {
    add("warning", "data_uri_image", "Images embedded as data: URIs are blocked or shown as attachments.", [GMAIL, OUTLOOK_WIN], "Host the image and link it by https URL.");
  }
  if (/<button\b/i.test(markup)) {
    add("warning", "button_element", "<button> elements do not work as links and look different in every client.", [OUTLOOK_WIN, GMAIL], 'Use a link styled as a button: <a href="..." style="display:inline-block;padding:12px 24px;...">.');
  }
  if (/border-radius\s*:/i.test(css)) {
    add("info", "border_radius", "Rounded corners show as square corners.", [OUTLOOK_WIN], "Nothing to do if square corners are acceptable there; VML <v:roundrect> buttons are the alternative.");
  }
  if (/box-shadow\s*:/i.test(css)) {
    add("info", "box_shadow", "Shadows are not shown.", [OUTLOOK_WIN, GMAIL], "Use a 1px border if the edge must be visible everywhere.");
  }
  if (/@keyframes|animation\s*:|transition\s*:/i.test(css)) {
    add("info", "animation", "CSS animations and transitions do not run.", [GMAIL, OUTLOOK_WIN, YAHOO], "Make sure the first frame is the complete design.");
  }
  if (/:hover/i.test(css)) {
    add("info", "hover", "Hover styles only work on desktop clients that support <style>; touch screens never hover.", [OUTLOOK_WIN, "mobile clients"], "Do not put information only in the hover state.");
  }
  if (/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*[\d.]+\s*\)|hsla?\(/i.test(css)) {
    add("info", "rgba_color", "rgba() and hsl() colors are ignored, so the element falls back to no color.", [OUTLOOK_WIN], "Use hex colors.");
  }
  const imgsWithoutAlt = [...markup.matchAll(/<img\b[^>]*>/gi)].filter((m) => !/\salt\s*=/i.test(m[0])).length;
  if (imgsWithoutAlt > 0) {
    add("info", "img_alt", `${imgsWithoutAlt} image${imgsWithoutAlt > 1 ? "s have" : " has"} no alt text; with images off (the default in Outlook for Windows) the reader sees nothing.`, [OUTLOOK_WIN], 'Add alt="..." describing the image, or alt="" for decoration.');
  }
  const layoutTables = [...markup.matchAll(/<table\b[^>]*>/gi)].filter((m) => !/role\s*=\s*["']presentation["']/i.test(m[0])).length;
  if (layoutTables > 0) {
    add("info", "table_role", `${layoutTables} table${layoutTables > 1 ? "s lack" : " lacks"} role="presentation", so screen readers announce layout as data tables.`, [], 'Add role="presentation" to every layout table.');
  }
  if (!/\{\{\s*preheader\s*\}\}/.test(source)) {
    add("info", "no_preheader", "The template has no {{preheader}}, so the inbox preview shows the first words of the email instead of the step's preview text.", [], "Place {{preheader}} right after <body>.");
  }
  if (!/<meta[^>]+name\s*=\s*["']viewport/i.test(markup)) {
    add("info", "no_viewport", "No viewport meta tag: some mobile clients render the email at desktop width and shrink it.", ["Apple Mail on iPhone", "Gmail app"], 'Add <meta name="viewport" content="width=device-width, initial-scale=1.0" />.');
  }
  if (utf8Bytes(source) > 40 * 1024) {
    add("warning", "large_template", "The template alone is over 40 KB; with a long body the message can pass the 102 KB at which Gmail clips it behind \"View entire message\".", [GMAIL], "Remove unused styles and comments.");
  }
  return issues;
}

/** Every finding: the save blockers first, then rendering checks. */
export function checkLayoutSource(source: string): LintIssue[] {
  return [...validateLayoutSource(source), ...lintLayoutSource(source)];
}
