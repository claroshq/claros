/**
 * Knowledge base import: read files into entries for POST /v1/kb/import.
 *
 * Pure functions, no I/O, so the dashboard import page and its tests share
 * them. Four formats:
 *
 *   - Markdown (.md, .markdown) and text (.txt): one entry per file. The
 *     title is the front matter `title`, else the first `# ` heading, else
 *     the file name; the key is `md:<file name>` unless the front matter
 *     sets `external_key`. A file longer than the content limit is split at
 *     its `## ` headings, one entry per section (`md:<file>#<section>`).
 *   - CSV (.csv, .tsv): a header row with `title` and `content`; optional
 *     `external_key`, `category`, `tags`, `pinned`, `active`,
 *     `content_type`, `source_url`. Other columns are kept in the entry's
 *     `data`. Without an `external_key` column the key is `csv:<title>`.
 *   - JSONL (.jsonl, .ndjson): one entry per line, the API's own format.
 *   - JSON (.json): an array of entries, or {"entries": [...]}.
 *
 * The server validates again and is the authority (its dry run reports
 * what would change); the checks here only let the page point at the row
 * that is wrong before anything is sent.
 */

/** Limits of POST /v1/kb/import (packages/api/src/routes/kb.ts). */
export const KB_IMPORT_LIMITS = {
  title: 200,
  content: 8_000,
  key: 200,
  category: 120,
} as const;

/** Entries per request; the API accepts at most 1,000. */
export const KB_IMPORT_BATCH_ENTRIES = 500;
/** Serialized bytes per request; the API accepts at most 4 MiB. */
export const KB_IMPORT_BATCH_BYTES = 3 * 1024 * 1024;
/** Largest file the page reads. */
export const KB_IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;

export type KbImportFormat = "markdown" | "text" | "csv" | "jsonl" | "json";

/** One entry as POST /v1/kb/import takes it. */
export interface KbImportEntry {
  external_key: string;
  title: string;
  content: string;
  content_type?: "markdown" | "html" | "text";
  category?: string | null;
  tags?: string[] | null;
  data?: unknown;
  pinned?: boolean;
  is_active?: boolean;
  active?: boolean;
  source_url?: string | null;
}

/** One entry read from a file, or the reason it cannot be imported. */
export interface KbImportRow {
  /** Where it came from, for people: "faq.csv row 4", "pricing.md". */
  source: string;
  entry: KbImportEntry | null;
  /** Non-empty when the row cannot be imported. */
  problems: string[];
  /** Best-effort title and key, also for rows with problems. */
  title: string;
  external_key: string;
}

export interface KbImportParse {
  rows: KbImportRow[];
  /** Files that could not be read at all. */
  fileErrors: string[];
}

const KNOWN_FIELDS = new Set([
  "external_key", "title", "content", "content_type", "category", "tags",
  "data", "pinned", "is_active", "active", "source_url",
]);
const CONTENT_TYPES = new Set(["markdown", "html", "text"]);

/** The format a file name stands for, or null when the page does not read it. */
export function formatOf(fileName: string): KbImportFormat | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "md":
    case "markdown":
    case "mdx":
      return "markdown";
    case "txt":
      return "text";
    case "csv":
    case "tsv":
      return "csv";
    case "jsonl":
    case "ndjson":
      return "jsonl";
    case "json":
      return "json";
    default:
      return null;
  }
}

/** File extensions for the file picker. */
export const KB_IMPORT_ACCEPT = ".md,.markdown,.mdx,.txt,.csv,.tsv,.jsonl,.ndjson,.json";

/** A key-safe slug: lowercase ASCII words joined by hyphens. */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  if (slug !== "") return slug;
  // Titles without Latin letters or digits: a stable hash of the text.
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return `t${h.toString(16)}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** Problems with one entry, measured against the API's rules. */
export function checkEntry(entry: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const field of Object.keys(entry)) {
    if (!KNOWN_FIELDS.has(field)) problems.push(`unknown field "${field}"`);
  }
  const str = (field: string, max: number, required: boolean) => {
    const v = entry[field];
    if (v === undefined || v === null) {
      if (required) problems.push(`${field} is missing`);
      return;
    }
    if (typeof v !== "string") {
      problems.push(`${field} must be text`);
      return;
    }
    if (required && v.trim() === "") problems.push(`${field} is empty`);
    else if (v.length > max) problems.push(`${field} is ${plural(v.length, "character")}; the limit is ${max.toLocaleString("en-US")}`);
  };
  str("external_key", KB_IMPORT_LIMITS.key, true);
  str("title", KB_IMPORT_LIMITS.title, true);
  str("content", KB_IMPORT_LIMITS.content, true);
  str("category", KB_IMPORT_LIMITS.category, false);
  str("source_url", 2000, false);
  if (entry.content_type !== undefined && !CONTENT_TYPES.has(String(entry.content_type))) {
    problems.push(`content_type must be markdown, html or text`);
  }
  if (entry.tags !== undefined && entry.tags !== null) {
    if (!Array.isArray(entry.tags) || entry.tags.some((t) => typeof t !== "string")) problems.push("tags must be a list of text values");
    else if (entry.tags.length > 50) problems.push("at most 50 tags");
  }
  for (const flag of ["pinned", "is_active", "active"]) {
    if (entry[flag] !== undefined && typeof entry[flag] !== "boolean") problems.push(`${flag} must be true or false`);
  }
  return problems;
}

function row(source: string, entry: Record<string, unknown>, extra: string[] = []): KbImportRow {
  const problems = [...extra, ...checkEntry(entry)];
  return {
    source,
    entry: problems.length === 0 ? (entry as unknown as KbImportEntry) : null,
    problems,
    title: typeof entry.title === "string" ? entry.title : "",
    external_key: typeof entry.external_key === "string" ? entry.external_key : "",
  };
}

// ---------------------------------------------------------------------------
// JSON and JSONL
// ---------------------------------------------------------------------------

function objectRows(fileName: string, items: unknown[], label: (i: number) => string): KbImportRow[] {
  return items.map((item, i) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { source: `${fileName} ${label(i)}`, entry: null, problems: ["not an object: each entry is {\"external_key\": ..., \"title\": ..., \"content\": ...}"], title: "", external_key: "" };
    }
    return row(`${fileName} ${label(i)}`, item as Record<string, unknown>);
  });
}

export function parseJsonl(fileName: string, text: string): KbImportParse {
  const rows: KbImportRow[] = [];
  text.replace(/^\uFEFF/, "").split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === "") return;
    let item: unknown;
    try {
      item = JSON.parse(line);
    } catch {
      rows.push({ source: `${fileName} line ${i + 1}`, entry: null, problems: ["not valid JSON"], title: "", external_key: "" });
      return;
    }
    rows.push(...objectRows(fileName, [item], () => `line ${i + 1}`));
  });
  return { rows, fileErrors: [] };
}

export function parseJson(fileName: string, text: string): KbImportParse {
  let body: unknown;
  try {
    body = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (err) {
    return { rows: [], fileErrors: [`${fileName}: not valid JSON (${(err as Error).message})`] };
  }
  const items = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { entries?: unknown }).entries)
      ? (body as { entries: unknown[] }).entries
      : null;
  if (items === null) {
    return { rows: [], fileErrors: [`${fileName}: expected a JSON array of entries or {"entries": [...]}`] };
  }
  return { rows: objectRows(fileName, items, (i) => `entry ${i + 1}`), fileErrors: [] };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** The delimiter of a CSV header line: comma, semicolon or tab, whichever is most frequent. */
function detectDelimiter(text: string, fileName: string): string {
  if (fileName.toLowerCase().endsWith(".tsv")) return "\t";
  const header = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t"].map((d) => [d, header.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ",";
}

/** RFC 4180 records: quoted fields may hold delimiters, quotes ("") and line breaks. */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === "") inQuotes = true;
    else if (ch === delimiter) {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += ch;
  }
  if (inQuotes) throw new Error("a quoted field is not closed");
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.filter((r) => !(r.length === 1 && r[0]!.trim() === ""));
}

const CSV_ALIASES: Record<string, string> = {
  key: "external_key",
  id: "external_key",
  externalkey: "external_key",
  body: "content",
  text: "content",
  is_active: "active",
};

function parseBool(raw: string): boolean | undefined | "invalid" {
  const v = raw.trim().toLowerCase();
  if (v === "") return undefined;
  if (["true", "yes", "y", "1", "x"].includes(v)) return true;
  if (["false", "no", "n", "0"].includes(v)) return false;
  return "invalid";
}

export function parseCsvFile(fileName: string, text: string): KbImportParse {
  let records: string[][];
  try {
    records = parseCsv(text, detectDelimiter(text.replace(/^\uFEFF/, ""), fileName));
  } catch (err) {
    return { rows: [], fileErrors: [`${fileName}: ${(err as Error).message}`] };
  }
  if (records.length === 0) return { rows: [], fileErrors: [`${fileName}: the file is empty`] };
  const header = records[0]!.map((h) => {
    const name = h.trim().toLowerCase().replace(/\s+/g, "_");
    return CSV_ALIASES[name] ?? name;
  });
  const missing = ["title", "content"].filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return {
      rows: [],
      fileErrors: [`${fileName}: the first row must name the columns; ${missing.map((m) => `"${m}"`).join(" and ")} ${missing.length === 1 ? "is" : "are"} missing (found: ${records[0]!.map((h) => `"${h.trim()}"`).join(", ")})`],
    };
  }
  const rows: KbImportRow[] = [];
  records.slice(1).forEach((cells, i) => {
    const source = `${fileName} row ${i + 2}`;
    const extra: string[] = [];
    const entry: Record<string, unknown> = {};
    const data: Record<string, string> = {};
    header.forEach((col, c) => {
      const raw = cells[c] ?? "";
      if (col === "") return;
      switch (col) {
        case "external_key":
        case "title":
        case "category":
        case "source_url":
        case "content_type":
          if (raw.trim() !== "") entry[col] = raw.trim();
          break;
        case "content":
          if (raw.trim() !== "") entry.content = raw.replace(/\r\n/g, "\n").trim();
          break;
        case "tags": {
          const tags = raw.split(/[,;|]/).map((t) => t.trim()).filter((t) => t !== "");
          if (tags.length > 0) entry.tags = tags;
          break;
        }
        case "pinned":
        case "active": {
          const b = parseBool(raw);
          if (b === "invalid") extra.push(`${col} is "${raw.trim()}"; use true or false`);
          else if (b !== undefined) entry[col] = b;
          break;
        }
        default:
          if (raw.trim() !== "") data[col] = raw;
      }
    });
    if (cells.every((c) => c.trim() === "")) return;
    if (entry.external_key === undefined && typeof entry.title === "string") entry.external_key = `csv:${slugify(entry.title)}`;
    if (Object.keys(data).length > 0) entry.data = data;
    rows.push(row(source, entry, extra));
  });
  if (rows.length === 0) return { rows, fileErrors: [`${fileName}: no rows below the header`] };
  return { rows, fileErrors: [] };
}

// ---------------------------------------------------------------------------
// Markdown and text
// ---------------------------------------------------------------------------

interface FrontMatter {
  fields: Record<string, string | string[]>;
  body: string;
}

/** Simple YAML front matter: `key: value`, `key: [a, b]` and `- item` lists. */
export function splitFrontMatter(text: string): FrontMatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const line of m[1]!.split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const list = fields[listKey];
      fields[listKey] = [...(Array.isArray(list) ? list : []), unquote(item[1]!)];
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!.trim();
    if (value === "") {
      listKey = key;
      fields[key] = [];
    } else if (value.startsWith("[") && value.endsWith("]")) {
      listKey = null;
      fields[key] = value.slice(1, -1).split(",").map((v) => unquote(v.trim())).filter((v) => v !== "");
    } else {
      listKey = null;
      fields[key] = unquote(value);
    }
  }
  return { fields, body: text.slice(m[0].length) };
}

function unquote(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return base === "" ? fileName : base.charAt(0).toUpperCase() + base.slice(1);
}

/** Split markdown at `## ` headings (outside code fences): the text before the first, then one part per heading. */
function splitSections(body: string): Array<{ heading: string | null; content: string }> {
  const parts: Array<{ heading: string | null; lines: string[] }> = [{ heading: null, lines: [] }];
  let fenced = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const h2 = fenced ? null : /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h2) parts.push({ heading: h2[1]!, lines: [] });
    else parts[parts.length - 1]!.lines.push(line);
  }
  return parts
    .map((p) => ({ heading: p.heading, content: p.lines.join("\n").trim() }))
    .filter((p) => p.heading !== null || p.content !== "");
}

export interface MarkdownOptions {
  format?: "markdown" | "text";
  /** The key when the front matter sets none; default `md:<file name>` (`txt:` for text). */
  keyFor?: (title: string) => string;
  /** Report a missing title instead of using the file name. */
  requireTitle?: boolean;
}

export function parseMarkdownFile(fileName: string, text: string, opts: MarkdownOptions = {}): KbImportParse {
  const format = opts.format ?? "markdown";
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const fm: FrontMatter = format === "markdown" ? splitFrontMatter(normalized) : { fields: {}, body: normalized };
  const fields = fm.fields;
  let body = fm.body.trim();
  let title = typeof fields.title === "string" ? fields.title : "";
  if (format === "markdown") {
    const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
    // The first heading is the title when it opens the document.
    if (h1 && body.slice(0, h1.index).trim() === "") {
      if (title === "") title = h1[1]!;
      body = body.slice(h1.index + h1[0].length).trim();
    }
  }
  const extra: string[] = [];
  if (title === "") {
    if (opts.requireTitle) extra.push("start the text with a # Title line, so the entry has a title");
    title = titleFromFileName(fileName);
  }

  const base: Record<string, unknown> = {};
  if (format === "text") base.content_type = "text";
  if (typeof fields.category === "string") base.category = fields.category;
  const tags = fields.tags;
  if (Array.isArray(tags) && tags.length > 0) base.tags = tags;
  else if (typeof tags === "string" && tags.trim() !== "") base.tags = tags.split(",").map((t) => t.trim()).filter((t) => t !== "");
  for (const flag of ["pinned", "active"] as const) {
    const v = fields[flag];
    if (typeof v !== "string") continue;
    const b = parseBool(v);
    if (b === "invalid") extra.push(`front matter ${flag} is "${v}"; use true or false`);
    else if (b !== undefined) base[flag] = b;
  }
  if (typeof fields.source_url === "string") base.source_url = fields.source_url;
  const key = typeof fields.external_key === "string"
    ? fields.external_key
    : opts.keyFor
      ? opts.keyFor(title)
      : `${format === "text" ? "txt" : "md"}:${fileName}`;

  if (body.length <= KB_IMPORT_LIMITS.content || format === "text") {
    return { rows: [row(fileName, { external_key: key, title, content: body, ...base }, extra)], fileErrors: [] };
  }

  // Too long for one entry: one entry per `## ` section.
  const sections = splitSections(body);
  if (sections.length <= 1) {
    return {
      rows: [row(fileName, { external_key: key, title, content: body, ...base }, [...extra, "add ## headings so Claros can split it into one entry per section, or shorten it"])],
      fileErrors: [],
    };
  }
  const used = new Map<string, number>();
  const rows = sections.map((s) => {
    const heading = s.heading;
    let slug = heading === null ? "intro" : slugify(heading);
    const n = (used.get(slug) ?? 0) + 1;
    used.set(slug, n);
    if (n > 1) slug = `${slug}-${n}`;
    const sectionTitle = heading === null ? title : `${title}: ${heading}`.slice(0, KB_IMPORT_LIMITS.title);
    const tooLong = s.content.length > KB_IMPORT_LIMITS.content ? ["split this section with more ## headings, or shorten it"] : [];
    return row(
      `${fileName}, ${heading === null ? "intro" : `section "${heading}"`}`,
      { external_key: `${key}#${slug}`, title: sectionTitle, content: s.content, ...base },
      [...extra, ...tooLong],
    );
  });
  return { rows, fileErrors: [] };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Mark rows whose key an earlier row already uses. */
function markDuplicateKeys(rows: KbImportRow[]): void {
  const first = new Map<string, string>();
  for (const r of rows) {
    if (r.external_key === "") continue;
    const earlier = first.get(r.external_key);
    if (earlier === undefined) {
      first.set(r.external_key, r.source);
      continue;
    }
    const hint = r.external_key.startsWith("csv:") ? " (two rows with the same title: add an external_key column)" : "";
    r.problems.push(`same key as ${earlier}${hint}`);
    r.entry = null;
  }
}

/** Read files (name and text) into entries. */
export function parseImportFiles(files: Array<{ name: string; text: string }>): KbImportParse {
  const out: KbImportParse = { rows: [], fileErrors: [] };
  for (const f of files) {
    const format = formatOf(f.name);
    let part: KbImportParse;
    switch (format) {
      case "markdown":
      case "text":
        part = parseMarkdownFile(f.name, f.text, { format });
        break;
      case "csv":
        part = parseCsvFile(f.name, f.text);
        break;
      case "jsonl":
        part = parseJsonl(f.name, f.text);
        break;
      case "json":
        part = parseJson(f.name, f.text);
        break;
      default:
        part = { rows: [], fileErrors: [`${f.name}: not a format the import reads (use .md, .txt, .csv, .jsonl or .json)`] };
    }
    out.rows.push(...part.rows);
    out.fileErrors.push(...part.fileErrors);
  }
  markDuplicateKeys(out.rows);
  return out;
}

/** The format pasted text is in: JSON, JSONL, CSV with a title/content header, else markdown. */
export function detectPastedFormat(text: string): KbImportFormat {
  const t = text.replace(/^\uFEFF/, "").trim();
  if (t.startsWith("[")) return "json";
  if (t.startsWith("{")) {
    const lines = t.split(/\r?\n/).filter((l) => l.trim() !== "");
    return lines.length > 1 && lines.every((l) => l.trim().startsWith("{")) ? "jsonl" : "json";
  }
  const header = (t.split(/\r?\n/, 1)[0] ?? "").toLowerCase();
  if (/(^|[,;\t]\s*"?)title"?\s*([,;\t]|$)/.test(header) && /(^|[,;\t]\s*"?)(content|body|text)"?\s*([,;\t]|$)/.test(header)) return "csv";
  return "markdown";
}

/** Read pasted text: the format is detected; a markdown paste is one entry (or one per section when long). */
export function parsePasted(text: string): KbImportParse & { format: KbImportFormat } {
  const format = detectPastedFormat(text);
  if (format === "markdown") {
    // A paste has no file name to key on: the key comes from the title.
    const parsed = parseMarkdownFile("pasted text", text, { keyFor: (title) => `paste:${slugify(title)}`, requireTitle: true });
    return { ...parsed, format };
  }
  const name = format === "csv" ? "pasted.csv" : format === "jsonl" ? "pasted.jsonl" : "pasted.json";
  const parsed = parseImportFiles([{ name, text }]);
  for (const r of parsed.rows) r.source = r.source.replace(/^pasted\.(csv|jsonl|json)/, "pasted text");
  parsed.fileErrors = parsed.fileErrors.map((e) => e.replace(/^pasted\.(csv|jsonl|json)/, "pasted text"));
  return { ...parsed, format };
}

/** Split entries into request-sized batches (count and serialized size). */
export function batchEntries(entries: KbImportEntry[]): KbImportEntry[][] {
  const batches: KbImportEntry[][] = [];
  let current: KbImportEntry[] = [];
  let bytes = 2;
  for (const e of entries) {
    const size = new TextEncoder().encode(JSON.stringify(e)).length + 1;
    if (current.length > 0 && (current.length >= KB_IMPORT_BATCH_ENTRIES || bytes + size > KB_IMPORT_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 2;
    }
    current.push(e);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Example files offered for download on the import page. */
export const KB_IMPORT_EXAMPLES = {
  csv: {
    name: "knowledge-base-example.csv",
    type: "text/csv",
    text: [
      "external_key,title,content,category,tags,pinned",
      'facts,Product facts,"Acme sends invoices from your accounting data. Plans: Starter and Team. Support answers within one business day.",facts,,true',
      'tip:saved-searches,Saved searches,"Save any search to get an email when new matches appear. Open a search, then choose Save.",tip_trick,"pro, team",false',
      'faq:export,Exporting data,"Every list has an Export button that downloads a CSV of the rows you see.",faq,,false',
    ].join("\n") + "\n",
  },
  jsonl: {
    name: "knowledge-base-example.jsonl",
    type: "application/x-ndjson",
    text: [
      { external_key: "facts", title: "Product facts", content: "Acme sends invoices from your accounting data. Plans: Starter and Team.", category: "facts", pinned: true },
      { external_key: "tip:saved-searches", title: "Saved searches", content: "Save any search to get an email when new matches appear.", category: "tip_trick", tags: ["pro", "team"] },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n",
  },
  markdown: {
    name: "saved-searches.md",
    type: "text/markdown",
    text: [
      "---",
      "category: tip_trick",
      "tags: [pro, team]",
      "---",
      "# Saved searches",
      "",
      "Save any search to get an email when new matches appear. Open a search, then choose **Save**.",
      "",
    ].join("\n"),
  },
} as const;
