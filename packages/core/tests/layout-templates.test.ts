/**
 * Email templates: the built-ins render and pass their own checks, the
 * wide layout is unchanged by the move to templates, placeholders fill in
 * one pass, and the checks catch what they claim to.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_LAYOUTS,
  builtinLayout,
  checkLayoutSource,
  DARK_LOGO_STYLE,
  isCustomLayoutRef,
  lintLayoutSource,
  renderLayout,
  resolveLayout,
  resolveMessageLayout,
  SAMPLE_BODY_HTML,
  SAMPLE_COMPLIANCE_HTML,
  tintHex,
  validateLayoutSource,
  wrapInShell,
  type EmailShellInput,
} from "../src/index.js";
import { NARROW_CASES } from "./fixtures/email-shell/cases.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures/email-shell");

const sample: EmailShellInput = {
  bodyHtml: SAMPLE_BODY_HTML,
  brand: { brand_name: "Acme", accent_color: "#ff5500" },
  tenantName: "Acme Inc",
  complianceFooterHtml: SAMPLE_COMPLIANCE_HTML,
  eyebrow: "Welcome",
  preheader: "Your workspace is ready",
};

describe("wide layout is unchanged by templates", () => {
  for (const [name, input] of Object.entries(NARROW_CASES)) {
    it(`${name}: brand.layout "wide" and brand.template "wide" render the pinned output`, () => {
      const pinned = readFileSync(join(fixtures, `wide-${name}.html`), "utf8");
      expect(wrapInShell({ ...input, brand: { ...input.brand, layout: "wide" } })).toBe(pinned);
      expect(wrapInShell({ ...input, brand: { ...input.brand, template: "wide" } })).toBe(pinned);
    });
    it(`${name}: brand.template "classic" renders the pinned narrow output`, () => {
      const pinned = readFileSync(join(fixtures, `narrow-${name}.html`), "utf8");
      expect(wrapInShell({ ...input, brand: { ...input.brand, template: "classic", layout: "wide" } })).toBe(pinned);
    });
  }
});

describe("built-in templates", () => {
  it("have unique keys, both widths, and at least three of each", () => {
    const keys = BUILTIN_LAYOUTS.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(BUILTIN_LAYOUTS.filter((b) => b.width === "narrow").length).toBeGreaterThanOrEqual(3);
    expect(BUILTIN_LAYOUTS.filter((b) => b.width === "wide").length).toBeGreaterThanOrEqual(3);
  });

  for (const b of BUILTIN_LAYOUTS) {
    describe(b.key, () => {
      it("passes validation and has no client warnings", () => {
        expect(validateLayoutSource(b.source)).toEqual([]);
        expect(lintLayoutSource(b.source).filter((i) => i.severity !== "info")).toEqual([]);
      });

      it("renders body, compliance footer, brand values and no leftover placeholder", () => {
        const html = renderLayout(b, sample);
        expect(html).toContain("Your workspace is ready");
        expect(html).toContain("https://example.com/unsubscribe");
        expect(html).toContain("1 Example Street");
        expect(html).toContain("Acme");
        expect(html).toContain('class="email-eyebrow"');
        expect(html).toContain('class="email-preheader"');
        expect(html).not.toMatch(/\{\{/);
        expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
      });

      if (b.width === "narrow") {
        it("guards every max-width with an Outlook ghost table", () => {
          const maxWidths = (b.source.match(/max-width:\d+px;margin:0 auto/g) ?? []).length;
          const ghosts = (b.source.match(/<!--\[if mso\]>\n<table role="presentation"[^>]*width="\d+" align="center"/g) ?? []).length;
          expect(maxWidths).toBeGreaterThan(0);
          expect(ghosts).toBe(maxWidths);
        });
      } else {
        it("uses only width=100% tables and gives paragraphs the measure", () => {
          for (const m of b.source.matchAll(/<table\b[^>]*>/g)) expect(m[0]).toContain('width="100%"');
          expect(renderLayout(b, sample)).toContain("max-width:680px;");
        });
      }
    });
  }
});

describe("rendering", () => {
  const t = { width: "narrow" as const, source: "<html><body>{{preheader}}<p>{{ brand_name }}</p>{{body}}<div>{{compliance_footer}}</div>{{nope}}</body></html>" };

  it("fills placeholders in one pass: text in the body is not read as a placeholder", () => {
    const html = renderLayout(t, { ...sample, bodyHtml: "<p>Hi {{brand_name}} $& $1</p>" });
    expect(html).toContain("<p>Hi {{brand_name}} $& $1</p>");
    expect(html).toContain("<p>Acme</p>");
  });

  it("renders unknown placeholders empty", () => {
    expect(renderLayout(t, sample)).not.toContain("nope");
  });

  it("escapes brand values", () => {
    const html = renderLayout(t, { ...sample, brand: { brand_name: '<b>"A&B"</b>' } });
    expect(html).toContain("&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;");
  });

  it("tints the accent toward white", () => {
    expect(tintHex("#000000", 0.5)).toBe("#808080");
    expect(tintHex("#f50", 0)).toBe("#ff5500");
    expect(tintHex("#2563ebcc", 1)).toBe("#ffffff");
  });
});

describe("dark-mode logo", () => {
  const withLogo = (brand: EmailShellInput["brand"]) => ({ ...sample, brand: { ...sample.brand, ...brand } });

  it("renders one logo and no swap rules without logo_dark_url", () => {
    const html = renderLayout(builtinLayout("classic")!, withLogo({ logo_url: "https://x.test/l.png" }));
    expect(html).toContain('<img src="https://x.test/l.png"');
    expect(html).not.toContain("claros-logo-dark");
    expect(html).not.toContain(".claros-logo-light");
  });

  it("ignores logo_dark_url without logo_url", () => {
    const html = renderLayout(builtinLayout("classic")!, withLogo({ logo_dark_url: "https://x.test/d.png" }));
    expect(html).not.toContain("d.png");
    expect(html).not.toContain("claros-logo-dark");
  });

  it("renders both logos, the dark one hidden inline and outside Outlook for Windows, with the rules in <head>", () => {
    for (const b of BUILTIN_LAYOUTS) {
      const html = renderLayout(b, withLogo({ logo_url: "https://x.test/l.png", logo_dark_url: "https://x.test/d.png", logo_height: 40 }));
      const head = html.slice(0, html.search(/<\/head>/i));
      expect(head, b.key).toContain(DARK_LOGO_STYLE);
      expect(html.split(DARK_LOGO_STYLE).length, b.key).toBe(2);
      expect(html, b.key).toContain('<img class="claros-logo-light" src="https://x.test/l.png"');
      expect(html, b.key).toMatch(/<!--\[if !mso\]><!--><img class="claros-logo-dark" src="https:\/\/x\.test\/d\.png" alt="Acme" height="40" style="display:none;[^"]*mso-hide:all;" \/><!--<!\[endif\]-->/);
    }
  });

  it("puts the rules next to the logo when a template has no <head>", () => {
    const html = renderLayout(
      { source: "<table><tr><td>{{logo}}</td></tr><tr><td>{{body}}{{compliance_footer}}</td></tr></table>", width: "narrow" },
      withLogo({ logo_url: "https://x.test/l.png", logo_dark_url: "https://x.test/d.png" }),
    );
    expect(html.startsWith("<table><tr><td>" + DARK_LOGO_STYLE + '<img class="claros-logo-light"')).toBe(true);
  });

  it("adds no rules to a template without {{logo}}", () => {
    const html = renderLayout(
      { source: "<html><head></head><body>{{logo_url}}{{body}}{{compliance_footer}}</body></html>", width: "narrow" },
      withLogo({ logo_url: "https://x.test/l.png", logo_dark_url: "https://x.test/d.png" }),
    );
    expect(html).not.toContain("claros-logo");
  });
});

describe("resolveLayout", () => {
  const custom = { width: "wide" as const, source: "<html><body>{{body}}{{compliance_footer}}</body></html>" };

  it("prefers the loaded custom template, then brand.template, then brand.layout", () => {
    expect(resolveLayout({ template: "3b1f0c52-1d2e-4c55-9a8e-2f4f0f6c9d10", layout: "wide" }, custom)).toBe(custom);
    expect(resolveLayout({ template: "letter", layout: "wide" }).source).toBe(builtinLayout("letter")!.source);
    expect(resolveLayout({ layout: "wide" }).source).toBe(builtinLayout("wide")!.source);
    expect(resolveLayout({}).source).toBe(builtinLayout("classic")!.source);
  });

  it("falls back to brand.layout when brand.template names nothing known", () => {
    expect(resolveLayout({ template: "3b1f0c52-1d2e-4c55-9a8e-2f4f0f6c9d10", layout: "wide" }, null).source).toBe(builtinLayout("wide")!.source);
    expect(resolveLayout({ template: "gone" }).source).toBe(builtinLayout("classic")!.source);
  });

  it("tells stored template ids from built-in keys", () => {
    expect(isCustomLayoutRef("3b1f0c52-1d2e-4c55-9a8e-2f4f0f6c9d10")).toBe(true);
    expect(isCustomLayoutRef("classic")).toBe(false);
    expect(isCustomLayoutRef(undefined)).toBe(false);
  });
});

describe("validation", () => {
  const ok = "<!DOCTYPE html><html><body>{{preheader}}{{body}}{{compliance_footer}}</body></html>";
  const rules = (s: string) => validateLayoutSource(s).map((i) => i.rule);

  it("accepts a minimal template", () => {
    expect(validateLayoutSource(ok)).toEqual([]);
  });

  it("requires {{body}} and {{compliance_footer}} exactly once", () => {
    expect(rules(ok.replace("{{body}}", ""))).toContain("missing_body");
    expect(rules(ok.replace("{{compliance_footer}}", ""))).toContain("missing_compliance_footer");
    expect(rules(ok.replace("{{body}}", "{{body}}{{ body }}"))).toContain("repeated_body");
  });

  it("refuses unknown placeholders, including merge variables", () => {
    const issues = validateLayoutSource(ok.replace("{{preheader}}", "{{contact.first_name}}{{logo_link}}"));
    expect(issues.map((i) => i.rule)).toEqual(["unknown_placeholder"]);
    expect(issues[0]!.message).toContain("{{contact.first_name}}");
  });

  it("refuses scripts, handlers, javascript: links, forms, frames and non-documents", () => {
    expect(rules(ok.replace("<body>", "<body><script>x()</script>"))).toContain("script");
    expect(rules(ok.replace("<body>", '<body onload="x()">'))).toContain("event_handler");
    expect(rules(ok.replace("<body>", '<body><a href="javascript:x()">a</a>'))).toContain("javascript_url");
    expect(rules(ok.replace("<body>", '<body><form action="/x"><input name="q"></form>'))).toContain("form");
    expect(rules(ok.replace("<body>", '<body><iframe src="https://x.example"></iframe>'))).toContain("embedded_content");
    expect(rules("{{body}}{{compliance_footer}}")).toContain("not_a_document");
    expect(rules("  ")).toEqual(["empty"]);
  });

  it("ignores markup inside plain comments but not in Outlook conditionals", () => {
    expect(rules(ok.replace("<body>", "<body><!-- <script>x</script> -->"))).toEqual([]);
    expect(rules(ok.replace("<body>", "<body><!--[if mso]><script>x</script><![endif]-->"))).toContain("script");
  });

  it("refuses templates over the size limit", () => {
    expect(rules(ok.replace("<body>", `<body>${"x".repeat(70_000)}`))).toContain("too_large");
  });
});

describe("client checks", () => {
  const base = '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width" /></head><body>{{preheader}}<table role="presentation" width="100%"><tr><td>{{body}}{{compliance_footer}}</td></tr></table></body></html>';
  const lint = (s: string) => lintLayoutSource(s).map((i) => i.rule);

  it("a clean template has no findings", () => {
    expect(lintLayoutSource(base)).toEqual([]);
  });

  it.each([
    ['<div style="display:flex">', "flexbox", "Outlook for Windows"],
    ['<div style="display: grid">', "grid", "Gmail"],
    ['<div style="position:absolute;top:0">', "position", "Gmail"],
    ['<td style="background-image:url(https://x.example/a.png)">', "background_image", "Outlook for Windows"],
    ['<td background="https://x.example/a.png">', "background_image", "Outlook for Windows"],
    ['<img src="https://x.example/logo.svg" alt="">', "svg", "Gmail"],
    ["<svg></svg>", "svg", "Gmail"],
    ["<style>@font-face{font-family:X;src:url(x.woff2)}</style>", "web_font", "Outlook for Windows"],
    ['<p style="color:var(--fg)">', "css_variables", "Gmail"],
    ['<table role="presentation" style="max-width:600px">', "max_width_without_ghost_table", "Outlook for Windows"],
    ['<table role="presentation" width="900">', "fixed_width", "Gmail app"],
    ["<video src=x.mp4></video>", "media", "Gmail"],
    ['<img src="data:image/png;base64,AAA" alt="">', "data_uri_image", "Gmail"],
    ["<button>Go</button>", "button_element", "Outlook for Windows"],
    ['<td style="border-radius:8px">', "border_radius", "Outlook for Windows"],
    ['<td style="box-shadow:0 1px 2px #000">', "box_shadow", "Outlook for Windows"],
    ['<td style="color:rgba(0,0,0,0.5)">', "rgba_color", "Outlook for Windows"],
    ['<img src="https://x.example/a.png">', "img_alt", "Outlook for Windows"],
  ])("%s -> %s", (snippet, rule, client) => {
    const issues = lintLayoutSource(base.replace("<body>", `<body>${snippet}`));
    const issue = issues.find((i) => i.rule === rule);
    expect(issue, JSON.stringify(issues)).toBeDefined();
    expect(issue!.clients).toContain(client);
    expect(issue!.fix.length).toBeGreaterThan(0);
  });

  it("max-width with a ghost table is fine", () => {
    expect(lint(base.replace("<body>", '<body><!--[if mso]><table role="presentation" width="600"><tr><td><![endif]--><table role="presentation" style="max-width:600px"><tr><td></td></tr></table>'))).toEqual([]);
  });

  it("notes a missing preheader, viewport and table role", () => {
    expect(lint(base.replace("{{preheader}}", ""))).toEqual(["no_preheader"]);
    expect(lint(base.replace(/<meta[^>]*>/, ""))).toEqual(["no_viewport"]);
    expect(lint(base.replace(' role="presentation"', ""))).toEqual(["table_role"]);
  });

  it("checkLayoutSource lists errors first", () => {
    const all = checkLayoutSource(base.replace("{{body}}", '<div style="display:flex">'));
    expect(all[0]!.severity).toBe("error");
    expect(all.map((i) => i.rule)).toContain("flexbox");
  });
});

describe("resolveMessageLayout", () => {
  const stored = { width: "wide" as const, source: "<html><body>{{body}}{{compliance_footer}}</body></html>" };
  const id = "3b1f0c52-1d2e-4c55-9a8e-2f4f0f6c9d10";
  const other = "9c2e7a10-0b1d-4f2a-8e3c-5d6f7a8b9c0d";
  const load = async (x: string) => (x === id ? stored : null);

  it("prefers the flow's template, built-in or stored", async () => {
    expect(await resolveMessageLayout({ template: "wide" }, "letter", load)).toEqual({ brand: { template: "letter" }, layout: null });
    expect(await resolveMessageLayout({ template: "wide" }, id, load)).toEqual({ brand: { template: id }, layout: stored });
  });

  it("falls back to the product's template when the flow has none or its template is gone", async () => {
    expect(await resolveMessageLayout({ template: "banner" }, null, load)).toEqual({ brand: { template: "banner" }, layout: null });
    expect(await resolveMessageLayout({ template: id }, other, load)).toEqual({ brand: { template: id }, layout: stored });
    expect(await resolveMessageLayout({ template: "banner" }, "nope", load)).toEqual({ brand: { template: "banner" }, layout: null });
  });

  it("falls back to brand.layout when neither names a usable template", async () => {
    const r = await resolveMessageLayout({ template: other, layout: "wide" }, null, load);
    expect(r).toEqual({ brand: { template: undefined, layout: "wide" }, layout: null });
    expect(wrapInShell({ ...{ bodyHtml: "<p>x</p>", tenantName: "A", complianceFooterHtml: "" }, brand: r.brand, layout: r.layout })).toContain('<td align="center" style="padding:24px 12px 40px 12px;">');
  });
});
