/**
 * Knowledge base import: reading files into entries for POST /v1/kb/import.
 */
import { describe, it, expect } from "vitest";
import {
  KB_IMPORT_BATCH_ENTRIES,
  KB_IMPORT_EXAMPLES,
  batchEntries,
  detectPastedFormat,
  formatOf,
  parseCsv,
  parseImportFiles,
  parsePasted,
  slugify,
  splitFrontMatter,
  type KbImportEntry,
} from "../src/kb-import.js";

describe("formatOf", () => {
  it("maps extensions to formats", () => {
    expect(formatOf("a.md")).toBe("markdown");
    expect(formatOf("A.MARKDOWN")).toBe("markdown");
    expect(formatOf("notes.txt")).toBe("text");
    expect(formatOf("faq.csv")).toBe("csv");
    expect(formatOf("faq.tsv")).toBe("csv");
    expect(formatOf("kb.jsonl")).toBe("jsonl");
    expect(formatOf("kb.ndjson")).toBe("jsonl");
    expect(formatOf("kb.json")).toBe("json");
    expect(formatOf("manual.pdf")).toBeNull();
  });
});

describe("slugify", () => {
  it("makes ASCII slugs and hashes titles without Latin letters", () => {
    expect(slugify("Saved searches: how to?")).toBe("saved-searches-how-to");
    expect(slugify("Öğrenci İndirimi")).toBe("ogrenci-indirimi");
    expect(slugify("料金")).toMatch(/^t[0-9a-f]+$/);
    expect(slugify("料金")).toBe(slugify("料金"));
  });
});

describe("parseCsv", () => {
  it("reads quoted fields with delimiters, quotes and line breaks", () => {
    const text = 'title,content\r\n"A, b","line 1\nline ""2"""\nC,d\n';
    expect(parseCsv(text)).toEqual([["title", "content"], ["A, b", 'line 1\nline "2"'], ["C", "d"]]);
  });

  it("throws on an unclosed quote", () => {
    expect(() => parseCsv('title,content\n"a,b')).toThrow(/not closed/);
  });
});

describe("CSV files", () => {
  it("reads title and content, optional columns, and keeps other columns in data", () => {
    const { rows, fileErrors } = parseImportFiles([
      {
        name: "faq.csv",
        text: "Title,Content,Category,Tags,Pinned,Plan\nPricing,Two plans.,facts,\"a, b\",yes,pro\n",
      },
    ]);
    expect(fileErrors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("faq.csv row 2");
    expect(rows[0]!.entry).toEqual({
      external_key: "csv:pricing",
      title: "Pricing",
      content: "Two plans.",
      category: "facts",
      tags: ["a", "b"],
      pinned: true,
      data: { plan: "pro" },
    });
  });

  it("uses the external_key column, aliases and semicolon delimiters", () => {
    const { rows } = parseImportFiles([{ name: "x.csv", text: "key;title;body;active\nk1;T;C;no\n" }]);
    expect(rows[0]!.entry).toEqual({ external_key: "k1", title: "T", content: "C", active: false });
  });

  it("names the missing columns", () => {
    const { rows, fileErrors } = parseImportFiles([{ name: "x.csv", text: "name,text\nA,B\n" }]);
    expect(rows).toEqual([]);
    expect(fileErrors[0]).toMatch(/"title" is missing/);
  });

  it("reports a row without content and an invalid boolean, and imports the rest", () => {
    const { rows } = parseImportFiles([{ name: "x.csv", text: "title,content,pinned\nA,,\nB,ok,maybe\nC,ok,\n" }]);
    expect(rows.map((r) => r.problems)).toEqual([
      ["content is missing"],
      ['pinned is "maybe"; use true or false'],
      [],
    ]);
    expect(rows[2]!.entry?.title).toBe("C");
  });

  it("flags two rows with the same title when there is no key column", () => {
    const { rows } = parseImportFiles([{ name: "x.csv", text: "title,content\nSame,a\nSame,b\n" }]);
    expect(rows[0]!.entry).not.toBeNull();
    expect(rows[1]!.entry).toBeNull();
    expect(rows[1]!.problems[0]).toMatch(/same key as x\.csv row 2.*add an external_key column/);
  });

  it("parses the downloadable example without problems", () => {
    const { rows, fileErrors } = parseImportFiles([{ name: KB_IMPORT_EXAMPLES.csv.name, text: KB_IMPORT_EXAMPLES.csv.text }]);
    expect(fileErrors).toEqual([]);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.problems.length === 0)).toBe(true);
    expect(rows[0]!.entry?.pinned).toBe(true);
  });
});

describe("JSONL and JSON files", () => {
  it("reads JSONL lines and points at the bad ones", () => {
    const text = [
      JSON.stringify({ external_key: "a", title: "A", content: "x" }),
      "",
      "{not json",
      JSON.stringify({ external_key: "b", title: "B" }),
      JSON.stringify({ external_key: "c", title: "C", content: "x", colour: "red" }),
    ].join("\n");
    const { rows } = parseImportFiles([{ name: "kb.jsonl", text }]);
    expect(rows.map((r) => [r.source, r.problems])).toEqual([
      ["kb.jsonl line 1", []],
      ["kb.jsonl line 3", ["not valid JSON"]],
      ["kb.jsonl line 4", ["content is missing"]],
      ["kb.jsonl line 5", ['unknown field "colour"']],
    ]);
  });

  it("reads a JSON array or {entries} and refuses other shapes", () => {
    const entry = { external_key: "a", title: "A", content: "x" };
    expect(parseImportFiles([{ name: "a.json", text: JSON.stringify([entry]) }]).rows[0]!.entry).toEqual(entry);
    expect(parseImportFiles([{ name: "b.json", text: JSON.stringify({ entries: [entry] }) }]).rows[0]!.entry).toEqual(entry);
    expect(parseImportFiles([{ name: "c.json", text: JSON.stringify({ title: "A" }) }]).fileErrors[0]).toMatch(/expected a JSON array/);
  });

  it("checks the API's limits", () => {
    const { rows } = parseImportFiles([
      { name: "a.json", text: JSON.stringify([{ external_key: "a", title: "A", content: "x".repeat(8001), tags: "one" }]) },
    ]);
    expect(rows[0]!.problems).toEqual(["content is 8,001 characters; the limit is 8,000", "tags must be a list of text values"]);
  });

  it("flags duplicate keys across files", () => {
    const entry = JSON.stringify({ external_key: "dup", title: "A", content: "x" });
    const { rows } = parseImportFiles([{ name: "one.jsonl", text: entry }, { name: "two.jsonl", text: entry }]);
    expect(rows[1]!.problems).toEqual(["same key as one.jsonl line 1"]);
  });
});

describe("Markdown files", () => {
  it("takes the title from the first heading and keys on the file name", () => {
    const { rows } = parseImportFiles([{ name: "saved-searches.md", text: "# Saved searches\n\nSave any search.\n" }]);
    expect(rows[0]!.entry).toEqual({ external_key: "md:saved-searches.md", title: "Saved searches", content: "Save any search." });
  });

  it("falls back to the file name for the title", () => {
    const { rows } = parseImportFiles([{ name: "refund_policy.md", text: "Refunds within 30 days." }]);
    expect(rows[0]!.entry?.title).toBe("Refund policy");
  });

  it("reads front matter", () => {
    const fm = splitFrontMatter("---\ntitle: \"Facts\"\ntags:\n  - a\n  - b\npinned: true\n---\nBody");
    expect(fm.fields).toEqual({ title: "Facts", tags: ["a", "b"], pinned: "true" });
    expect(fm.body).toBe("Body");
    const { rows } = parseImportFiles([{ name: KB_IMPORT_EXAMPLES.markdown.name, text: KB_IMPORT_EXAMPLES.markdown.text }]);
    expect(rows[0]!.entry).toEqual({
      external_key: "md:saved-searches.md",
      title: "Saved searches",
      content: "Save any search to get an email when new matches appear. Open a search, then choose **Save**.",
      category: "tip_trick",
      tags: ["pro", "team"],
    });
  });

  it("splits a long file at ## headings, outside code fences", () => {
    const section = "word ".repeat(1000);
    const text = `# Guide\n\nIntro text.\n\n## Setup\n\n${section}\n\n\`\`\`\n## not a heading\n\`\`\`\n\n## Usage\n\n${section}\n\n## Usage\n\nAgain.`;
    const { rows } = parseImportFiles([{ name: "guide.md", text }]);
    expect(rows.map((r) => [r.external_key, r.title, r.problems])).toEqual([
      ["md:guide.md#intro", "Guide", []],
      ["md:guide.md#setup", "Guide: Setup", []],
      ["md:guide.md#usage", "Guide: Usage", []],
      ["md:guide.md#usage-2", "Guide: Usage", []],
    ]);
    expect(rows[1]!.entry?.content).toContain("## not a heading");
  });

  it("asks for ## headings when a long file has none", () => {
    const { rows } = parseImportFiles([{ name: "long.md", text: "x".repeat(9000) }]);
    expect(rows[0]!.entry).toBeNull();
    expect(rows[0]!.problems[0]).toMatch(/add ## headings/);
  });

  it("imports text files as content_type text", () => {
    const { rows } = parseImportFiles([{ name: "notes.txt", text: "# not a heading in text\nplain" }]);
    expect(rows[0]!.entry).toEqual({ external_key: "txt:notes.txt", title: "Notes", content: "# not a heading in text\nplain", content_type: "text" });
  });

  it("refuses unknown file types", () => {
    expect(parseImportFiles([{ name: "a.pdf", text: "" }]).fileErrors[0]).toMatch(/not a format the import reads/);
  });
});

describe("pasted text", () => {
  it("detects the format", () => {
    expect(detectPastedFormat('[{"title": "a"}]')).toBe("json");
    expect(detectPastedFormat('{"a": 1}\n{"b": 2}')).toBe("jsonl");
    expect(detectPastedFormat('{"entries": []}')).toBe("json");
    expect(detectPastedFormat("title,content\nA,B")).toBe("csv");
    expect(detectPastedFormat("Title;Body\nA;B")).toBe("csv");
    expect(detectPastedFormat("# Pricing\n\nTwo plans.")).toBe("markdown");
  });

  it("keys a markdown paste on its title and asks for one when missing", () => {
    const ok = parsePasted("# Refund policy\n\nRefunds within 30 days.");
    expect(ok.rows[0]!.entry).toEqual({ external_key: "paste:refund-policy", title: "Refund policy", content: "Refunds within 30 days." });
    const noTitle = parsePasted("Refunds within 30 days.");
    expect(noTitle.rows[0]!.entry).toBeNull();
    expect(noTitle.rows[0]!.problems[0]).toMatch(/# Title line/);
  });

  it("names pasted CSV rows as pasted text", () => {
    const { rows, format } = parsePasted("title,content\nA,B");
    expect(format).toBe("csv");
    expect(rows[0]!.source).toBe("pasted text row 2");
  });
});

describe("batchEntries", () => {
  it("splits by count and by size", () => {
    const small: KbImportEntry[] = Array.from({ length: KB_IMPORT_BATCH_ENTRIES + 1 }, (_, i) => ({ external_key: `k${i}`, title: "T", content: "c" }));
    expect(batchEntries(small).map((b) => b.length)).toEqual([KB_IMPORT_BATCH_ENTRIES, 1]);
    const big: KbImportEntry[] = Array.from({ length: 450 }, (_, i) => ({ external_key: `k${i}`, title: "T", content: "x".repeat(8000) }));
    const batches = batchEntries(big);
    expect(batches.length).toBe(2);
    expect(batches.flat()).toHaveLength(450);
  });
});
