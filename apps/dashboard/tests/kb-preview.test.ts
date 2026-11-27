import { describe, expect, it } from "vitest";
import { categoryLabel, matchesQuery, plainPreview } from "../src/kb-preview.js";
import type { KbEntryPreview } from "../src/api.js";

describe("plainPreview", () => {
  it("strips markdown emphasis, headings, lists and links", () => {
    const raw = "## Plans\n\nFree $0. **Quota**: unique companies.\n- see [billing](https://x.test/b)\n- `code` and _soft_";
    expect(plainPreview(raw)).toBe(
      "Plans. Free $0. Quota: unique companies. see billing. code and soft",
    );
  });

  it("turns unpunctuated line breaks into sentence breaks", () => {
    expect(plainPreview("## Saved searches\n- Save any filter set\n- Get a daily digest")).toBe(
      "Saved searches. Save any filter set. Get a daily digest",
    );
  });

  it("keeps snake_case words and arithmetic intact", () => {
    expect(plainPreview("Use kb_select with 2 * 3 items")).toBe("Use kb_select with 2 * 3 items");
  });

  it("drops a dangling bold marker cut off by the 300-char truncation", () => {
    expect(plainPreview("Pricing is **monthly and")).toBe("Pricing is monthly and");
  });

  it("strips tags and entities from html", () => {
    expect(plainPreview("<p>Hello&nbsp;<b>world</b> &amp; more</p>", "html")).toBe("Hello world & more");
  });

  it("leaves plain text alone apart from whitespace", () => {
    expect(plainPreview("**not** markdown\n\nhere", "text")).toBe("**not** markdown here");
  });
});

describe("categoryLabel", () => {
  it("turns a key into a heading", () => {
    expect(categoryLabel("feature_edu")).toBe("Feature edu");
    expect(categoryLabel("facts")).toBe("Facts");
    expect(categoryLabel("Onboarding-tips")).toBe("Onboarding tips");
  });
});

describe("matchesQuery", () => {
  const e = {
    title: "Plans, quota and founding price",
    content_preview: "Free $0. Pro $49/month",
    category: "facts",
    tags: ["plan-pro", "billing"],
  } as KbEntryPreview;

  it("matches every term across fields, case-insensitively", () => {
    expect(matchesQuery(e, "")).toBe(true);
    expect(matchesQuery(e, "QUOTA billing")).toBe(true);
    expect(matchesQuery(e, "facts $49")).toBe(true);
    expect(matchesQuery(e, "quota refunds")).toBe(false);
  });
});
