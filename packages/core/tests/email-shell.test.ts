/**
 * Email shell layouts: the narrow layout (the default) renders byte for
 * byte as pinned (fixtures regenerated deliberately when the shell changes), and the wide layout has the
 * full-width card, the paragraph measure, the .pad media query and no
 * Outlook ghost table.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { wrapInShell, applyWideBodyLayout, FONT_STACK, TEXT_MEASURE, clarosConfigSchema, planConfig, type BrandSettings, type ConfigState } from "../src/index.js";
import { NARROW_CASES } from "./fixtures/email-shell/cases.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures/email-shell");

describe("narrow layout (default) is unchanged", () => {
  for (const [name, input] of Object.entries(NARROW_CASES)) {
    const pinned = readFileSync(join(fixtures, `narrow-${name}.html`), "utf8");

    it(`${name}: no layout renders the pinned output`, () => {
      expect(wrapInShell(input)).toBe(pinned);
    });

    it(`${name}: layout "narrow" and unknown values render the pinned output`, () => {
      expect(wrapInShell({ ...input, brand: { ...input.brand, layout: "narrow" } })).toBe(pinned);
      const unknown = { ...input.brand, layout: "full" } as unknown as BrandSettings;
      expect(wrapInShell({ ...input, brand: unknown })).toBe(pinned);
    });
  }
});

describe("font", () => {
  for (const layout of ["narrow", "wide"] as const) {
    const html = wrapInShell({ ...NARROW_CASES.full!, brand: { ...NARROW_CASES.full!.brand, layout } });
    it(`${layout}: every content cell carries the font stack (Outlook does not inherit it from <body>)`, () => {
      const cells = [...html.matchAll(/<td class="email-container[^"]*"[^>]*>/g)];
      expect(cells).toHaveLength(3);
      for (const m of cells) expect(m[0]).toContain(`font-family:${FONT_STACK};`);
      expect(html).toContain(`<body class="email-body" style="margin:0;padding:0;background-color:#f9fafb;font-family:${FONT_STACK};">`);
    });
    it(`${layout}: Outlook gets an Arial fallback in an mso-only style block`, () => {
      expect(html).toMatch(/<!--\[if mso\]>\n<style>\nbody, table, td, p, a, li, h1, h2, h3, span \{ font-family: Arial, sans-serif !important; \}\n<\/style>\n<!\[endif\]-->/);
    });
  }
});

describe("wide layout", () => {
  const input = NARROW_CASES.full!;
  const html = wrapInShell({ ...input, brand: { ...input.brand, layout: "wide" } });

  it("has a full-width card with no fixed width and no max-width", () => {
    expect(html).not.toMatch(/max-width:600px/);
    expect(html).not.toMatch(/width="600"/);
    expect(html).toContain('<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">');
    // Page gutter on the background.
    expect(html).toContain('<td align="center" style="padding:24px 12px 40px 12px;">');
  });

  it("needs no Outlook ghost table", () => {
    expect(html).not.toContain("<!--[if mso]>\n<table");
    for (const m of html.matchAll(/<table\b[^>]*>/g)) expect(m[0]).toContain('width="100%"');
  });

  it("pads content 40px, 20px under 760px through .pad, and makes buttons full width on small screens", () => {
    const padded = [...html.matchAll(/<td class="[^"]*\bpad\b[^"]*"[^>]*style="[^"]*padding:\d+px 40px \d+(?:px)? 40px;/g)];
    expect(padded).toHaveLength(3);
    expect(html).toMatch(/@media only screen and \(max-width: 760px\) \{\s*\.pad \{ padding-left: 20px !important; padding-right: 20px !important; \}\s*\.email-button \{ display: block !important; text-align: center !important; \}/);
  });

  it("keeps header, eyebrow, preheader, accent, dark mode block and footer", () => {
    expect(html).toContain('<img src="https://news.example.com/brand/logo?v=1" alt="Acme" height="40"');
    expect(html).toContain('class="email-eyebrow"');
    expect(html).toContain('class="email-preheader"');
    expect(html).toContain("background-color:#ff5500;");
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain("You signed up at acme.example.");
    expect(html).toContain('<a href="https://x.example/unsub">Unsubscribe</a>');
  });

  it("gives body paragraphs an inline max-width and leaves lists, headings and the footer alone", () => {
    expect(html).toContain(`<p style="margin:0 0 16px 0;line-height:1.6;max-width:${TEXT_MEASURE}px;">First paragraph`);
    expect(html).toContain('<ul style="margin:0 0 16px 0;padding-left:24px;">');
    expect(html).toContain('<li style="margin:0 0 6px 0;line-height:1.5;">One</li>');
    expect(html).toContain('<h1 style="font-size:22px;font-weight:700;margin:0 0 16px 0;line-height:1.3;">Welcome</h1>');
    expect(html).toContain('<p style="margin:0 0 6px 0;">You signed up at acme.example.</p>');
    expect(html).toContain('<p style="margin:0 0 4px 0;"><a href="https://x.example/unsub">');
  });
});

describe("applyWideBodyLayout", () => {
  it("adds the measure to every paragraph form", () => {
    expect(applyWideBodyLayout("<p>a</p>")).toBe('<p style="max-width:680px;">a</p>');
    expect(applyWideBodyLayout('<p style="color:red">a</p>')).toBe('<p style="color:red;max-width:680px;">a</p>');
    expect(applyWideBodyLayout('<p style="">a</p>')).toBe('<p style="max-width:680px;">a</p>');
    expect(applyWideBodyLayout('<p class="x">a</p>')).toBe('<p class="x" style="max-width:680px;">a</p>');
  });

  it("does not touch pre, param-like tags or escaped markup", () => {
    const s = '<pre style="margin:0;"><code>&lt;p&gt;x&lt;/p&gt;</code></pre><param name="a">';
    expect(applyWideBodyLayout(s)).toBe(s);
  });

  it("marks inline-block links as buttons, and only those", () => {
    expect(applyWideBodyLayout('<a href="u" style="display:inline-block;padding:12px;">Go</a>')).toBe(
      '<a class="email-button" href="u" style="display:inline-block;padding:12px;">Go</a>',
    );
    const link = '<a href="u" style="color:#2563eb;">x</a>';
    expect(applyWideBodyLayout(link)).toBe(link);
    const classed = '<a class="k" href="u" style="display:inline-block;">x</a>';
    expect(applyWideBodyLayout(classed)).toBe(classed);
  });
});

describe("config schema: settings.brand.layout", () => {
  const doc = (brand: unknown) => ({ settings: { brand } });

  it("accepts narrow and wide and keeps the other brand keys", () => {
    for (const layout of ["narrow", "wide"]) {
      const r = clarosConfigSchema.safeParse(doc({ brand_name: "Acme", layout }));
      expect(r.success).toBe(true);
      expect(r.success && r.data.settings?.brand).toEqual({ brand_name: "Acme", layout });
    }
    expect(clarosConfigSchema.safeParse(doc({ brand_name: "Acme", custom_key: 1 })).success).toBe(true);
  });

  it("rejects other layout values", () => {
    for (const layout of ["full", "", 1, null]) {
      expect(clarosConfigSchema.safeParse(doc({ layout })).success).toBe(false);
    }
  });
});

describe("config plan: settings.brand.layout", () => {
  const state = (brand: Record<string, unknown> | undefined): ConfigState => ({
    settings: brand ? { brand } : {}, locale: null, configVersion: 1, topics: [], templates: [], flows: [], transports: [], endpoints: [],
  });
  const deps = { newId: () => "id", newSecret: () => "s", readSecret: () => null };
  const plan = (brand: unknown, have: Record<string, unknown> | undefined) =>
    planConfig(clarosConfigSchema.parse({ settings: { brand } }), state(have), deps);

  it("reports a change and patches brand when the layout differs", () => {
    const p = plan({ brand_name: "Acme", layout: "wide" }, { brand_name: "Acme" });
    expect(p.changes).toEqual([{ kind: "setting", key: "brand", action: "update" }]);
    expect(p.ops).toEqual([{ op: "setSettings", patch: { brand: { brand_name: "Acme", layout: "wide" } } }]);
  });

  it("round-trips: the exported brand applied again changes nothing", () => {
    const stored = { brand_name: "Acme", layout: "wide" };
    expect(plan(stored, stored)).toMatchObject({ changes: [], ops: [], errors: [] });
  });
});
