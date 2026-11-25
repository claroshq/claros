/**
 * Markdown to email-safe HTML and plain text, for drafted content (worker)
 * and approval edits (API, G20). Moved from packages/worker/src/content.ts.
 */
import { marked, Renderer, Lexer, type Token, type Tokens } from "marked";

// ---------------------------------------------------------------------------
// Markdown rendering helpers
// ---------------------------------------------------------------------------

/**
 * Escape HTML special characters to entity references.
 * Used to neutralise raw HTML that passes through the marked token pipeline.
 */
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Return true for URL schemes that are safe to render as href/src values.
 * Rejects javascript:, data:, vbscript:, and any other non-HTTP schemes.
 */
function isSafeUrl(url: string): boolean {
  return (
    /^(?:https?|mailto):/i.test(url) ||
    url.startsWith("/") ||
    url.startsWith("#") ||
    url.startsWith(".")
  );
}

/**
 * Build a marked Renderer that disables raw HTML passthrough and blocks
 * dangerous URL schemes in link/image href attributes.
 *
 * marked v18 produces one token type for all raw HTML, regardless of position:
 * block-level HTML (e.g. a bare <script> tag) and inline HTML inside a
 * paragraph, list item, or link text all produce a token of type "html" with
 * a "block" boolean field distinguishing them. The renderer's html() method is
 * invoked for both. Overriding it once is sufficient to cover every path.
 *
 * The only other attribute values that marked's renderer writes from markdown
 * input are: href/src (overridden below), and title/alt (escaped by marked's
 * internal O() function which encodes & < > " ' to entity references, making
 * attribute boundary escape impossible). No post-render string pass is needed.
 */
/**
 * Build a marked Renderer that produces email-safe, inline-styled HTML.
 *
 * Security overrides:
 *   1. html(): all raw HTML tokens are escaped to entity references.
 *   2. link()/image(): dangerous URL schemes are replaced with safe fallbacks.
 *
 * Email-safe overrides:
 *   - Paragraphs, headings, lists, blockquotes, code blocks, and horizontal
 *     rules all carry inline styles suitable for email rendering.
 *   - No class names, no external CSS references.
 *   - Font sizes and spacing designed to look good inside the email shell's
 *     15px/1.6 body content area.
 *
 * Allowed markdown constructs:
 *   - Paragraphs, bold, italic, strikethrough
 *   - Headings (h1-h3 only; h4-h6 rendered as h3)
 *   - Ordered and unordered lists
 *   - Links (http/https only)
 *   - Images (http/https only, max-width constrained)
 *   - Blockquotes
 *   - Code (inline and fenced blocks)
 *   - Horizontal rules
 *
 * Stripped/escaped:
 *   - Raw HTML (any tag the model emits becomes visible text)
 *   - Dangerous URL schemes (javascript:, data:, vbscript:, etc.)
 *   - Tables (complex layout, unreliable in email clients)
 */
function buildSafeRenderer(): Renderer {
  const renderer = new Renderer();

  // Escape all raw HTML tokens (block and inline) to entity references.
  // This covers: <script>, <iframe>, <img onerror=...>, inline <b onclick=...>,
  // and any other tag the model emits, wherever it appears in the document.
  renderer.html = ({ raw }: { raw: string }): string => escapeHtml(raw);

  // Paragraphs: standard spacing for email
  renderer.paragraph = ({ tokens }: { tokens: Token[] }): string => {
    const body = renderer.parser.parseInline(tokens);
    return `<p style="margin:0 0 16px 0;line-height:1.6;">${body}</p>\n`;
  };

  // Headings: only h1-h3, all others become h3
  renderer.heading = ({ tokens, depth }: { tokens: Token[]; depth: number }): string => {
    const body = renderer.parser.parseInline(tokens);
    const level = Math.min(depth, 3);
    const styles: Record<number, string> = {
      1: "font-size:22px;font-weight:700;margin:0 0 16px 0;line-height:1.3;",
      2: "font-size:18px;font-weight:600;margin:0 0 12px 0;line-height:1.3;",
      3: "font-size:16px;font-weight:600;margin:0 0 10px 0;line-height:1.4;",
    };
    return `<h${level} style="${styles[level]}">${body}</h${level}>\n`;
  };

  // Lists: inline padding for email
  renderer.list = (token: Tokens.List): string => {
    const tag = token.ordered ? "ol" : "ul";
    const startAttr = token.ordered && token.start !== 1 && token.start !== "" ? ` start="${token.start}"` : "";
    const style = "margin:0 0 16px 0;padding-left:24px;";
    const itemsHtml = token.items.map((item) => renderer.listitem(item)).join("");
    return `<${tag}${startAttr} style="${style}">\n${itemsHtml}</${tag}>\n`;
  };

  renderer.listitem = (item: Tokens.ListItem): string => {
    const body = renderer.parser.parse(item.tokens);
    return `<li style="margin:0 0 6px 0;line-height:1.5;">${body}</li>\n`;
  };

  // Blockquotes: left border with padding
  renderer.blockquote = ({ tokens }: Tokens.Blockquote): string => {
    const body = renderer.parser.parse(tokens);
    return `<blockquote style="margin:0 0 16px 0;padding:12px 16px;border-left:3px solid #d1d5db;color:#4b5563;">${body}</blockquote>\n`;
  };

  // Code blocks: monospace background
  renderer.code = ({ text, lang }: { text: string; lang?: string }): string => {
    void lang;
    return `<pre style="margin:0 0 16px 0;padding:12px 16px;background-color:#f3f4f6;border-radius:6px;overflow-x:auto;"><code style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:13px;line-height:1.5;color:#1f2937;">${escapeHtml(text)}</code></pre>\n`;
  };

  // Inline code
  renderer.codespan = ({ text }: { text: string }): string => {
    return `<code style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:13px;padding:2px 5px;background-color:#f3f4f6;border-radius:3px;">${text}</code>`;
  };

  // Horizontal rule
  renderer.hr = (): string => {
    return `<hr style="margin:24px 0;border:none;border-top:1px solid #e5e7eb;" />\n`;
  };

  // Images: constrained width for email safety
  renderer.image = ({ href, title, text }: Tokens.Image): string => {
    const safeHref = isSafeUrl(href ?? "") ? href : "";
    if (!safeHref) return "";
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text || "")}"${titleAttr} style="max-width:100%;height:auto;display:block;margin:0 0 16px 0;border:0;" />`;
  };

  // Links: safe URL with accent color
  renderer.link = ({ href, title, tokens }: Tokens.Link): string => {
    const safeHref = isSafeUrl(href ?? "") ? href : "#";
    const body = renderer.parser.parseInline(tokens);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(safeHref)}"${titleAttr} style="color:#2563eb;text-decoration:underline;">${body}</a>`;
  };

  // Tables: strip entirely (unreliable in email clients, and the model
  // should not be producing tabular data in lifecycle emails)
  renderer.table = (): string => "";
  renderer.tablerow = (): string => "";
  renderer.tablecell = (): string => "";

  return renderer;
}

/**
 * Render markdown string to sanitised HTML.
 *
 * Security model: `body_markdown` is model-generated text. Although the draft
 * prompt requests markdown-only output, there is no schema-level enforcement
 * preventing the model from emitting HTML (script tags, event handlers,
 * iframes, javascript: hrefs). Two renderer-level overrides handle this:
 *
 *   1. html() override: all raw HTML tokens - block and inline - are escaped
 *      to entity references. Model-emitted tags become visible text, not
 *      markup. This covers every position: bare block tags, tags mid-paragraph,
 *      tags inside list items, and tags inside link or image text.
 *   2. link/image overrides: hrefs using non-HTTP schemes (javascript:, data:,
 *      vbscript:, ...) are replaced with safe fallbacks ('#' for links, '' for
 *      images).
 *
 * No post-render string pass is applied. All dangerous content originates from
 * raw HTML tokens (handled by override 1) or href values (handled by override
 * 2). marked's own renderer encodes title and alt attribute values with its
 * internal escape function (& < > " ' -> entities), so no attribute boundary
 * escape is possible from those paths.
 *
 * Normal markdown constructs (headings, bold, italic, lists, code, links with
 * https:// hrefs) are rendered to HTML unchanged.
 */
export function renderMarkdownToHtml(markdown: string): string {
  const renderer = buildSafeRenderer();
  return marked.parse(markdown, { async: false, renderer }) as string;
}

// ---------------------------------------------------------------------------
// Plain-text derivation (from markdown source, not from rendered HTML)
// ---------------------------------------------------------------------------

/**
 * Decode the small set of HTML entities that marked encodes in token text
 * fields (it only encodes &, <, >, ", ' in text nodes).
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Recursively convert a marked token list to a plain-text string.
 *
 * Design choices:
 * - Derived from the markdown token tree, not from rendered HTML, so raw
 *   HTML blocks in the source are discarded rather than partially stripped.
 * - Links: rendered as "text (url)" so the URL survives in the plain-text
 *   version (important for email clients that render the text/plain part).
 * - Lists: unordered items get a "- " prefix; ordered items get "N. ".
 * - Headings: text only, no "#" markers - headings are structurally a
 *   paragraph boundary in plain-text email.
 * - Code blocks: content preserved verbatim.
 * - Raw HTML tokens (type "html"): discarded entirely.
 */
function tokensToText(tokens: Token[]): string {
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "heading":
        out += tokensToText(token.tokens ?? []) + "\n\n";
        break;

      case "paragraph":
        out += tokensToText(token.tokens ?? []) + "\n\n";
        break;

      case "strong":
      case "em":
      case "del":
        out += tokensToText(token.tokens ?? []);
        break;

      case "text":
        // text tokens can have sub-tokens (e.g., inside a list item)
        if (token.tokens && token.tokens.length > 0) {
          out += tokensToText(token.tokens);
        } else {
          out += decodeEntities(token.text);
        }
        break;

      case "link": {
        const linkText = tokensToText(token.tokens ?? []);
        if (token.href && token.href !== linkText) {
          out += `${linkText} (${token.href})`;
        } else {
          out += linkText;
        }
        break;
      }

      case "image":
        if (token.href) {
          out += `${token.text} (${token.href})`;
        } else {
          out += token.text;
        }
        break;

      case "list": {
        for (let i = 0; i < token.items.length; i++) {
          const item = token.items[i]!;
          const prefix = token.ordered ? `${(token.start as number) + i}. ` : "- ";
          out += prefix + tokensToText(item.tokens ?? []).trim() + "\n";
        }
        out += "\n";
        break;
      }

      case "blockquote": {
        const quoted = tokensToText(token.tokens ?? []).trim();
        out +=
          quoted
            .split("\n")
            .map((l) => (l ? "> " + l : ">"))
            .join("\n") + "\n\n";
        break;
      }

      case "code":
        out += token.text + "\n\n";
        break;

      case "codespan":
        out += token.text;
        break;

      case "br":
        out += "\n";
        break;

      case "hr":
        out += "---\n\n";
        break;

      case "html":
        // Discard raw HTML blocks in plain text output.
        break;

      case "space":
        // Blank lines between blocks are handled by the "\n\n" each block emits.
        break;

      default:
        // Unknown token type: fall back to sub-tokens if present, then text.
        if ("tokens" in token && Array.isArray((token as { tokens?: Token[] }).tokens)) {
          out += tokensToText((token as { tokens: Token[] }).tokens);
        } else if ("text" in token && typeof (token as { text?: string }).text === "string") {
          out += decodeEntities((token as { text: string }).text);
        }
    }
  }
  return out;
}

/**
 * Derive a plain-text version of the email body from the original markdown
 * source.
 *
 * Deriving from markdown rather than from rendered HTML avoids re-processing
 * any HTML the model may have injected - those tokens are simply discarded.
 * The result is suitable for the text/plain MIME part of the outgoing email.
 *
 * Link targets are preserved as "(url)" suffixes so recipients using
 * plain-text clients still have the URLs. List structure uses "- " (unordered)
 * or "N. " (ordered) prefixes. Heading levels are collapsed to plain text
 * paragraph boundaries.
 */
export function markdownToText(markdown: string): string {
  const tokens = Lexer.lex(markdown);
  return tokensToText(tokens)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

