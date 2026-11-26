import { describe, expect, it } from "vitest";
import { groupEntries, UNCATEGORIZED } from "../src/kb-groups.js";
import type { KbEntryPreview } from "../src/api.js";

function entry(id: string, category: string | null, pinned = false): KbEntryPreview {
  return {
    id,
    tenant_id: "t",
    title: id,
    content_preview: "",
    content_type: "markdown",
    source: "manual",
    source_url: null,
    tags: [],
    embedding_status: null,
    is_active: true,
    category,
    pinned,
    created_at: "2026-11-25T00:00:00Z",
    updated_at: "2026-11-25T00:00:00Z",
  };
}

describe("groupEntries", () => {
  it("groups by category, sorted, uncategorized last", () => {
    const groups = groupEntries([
      entry("a", "onboarding"),
      entry("b", null),
      entry("c", "facts"),
      entry("d", "onboarding"),
      entry("e", "  "),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["facts", "onboarding", UNCATEGORIZED]);
    expect(groups[1]!.entries.map((e) => e.id)).toEqual(["a", "d"]);
    expect(groups[2]!.entries.map((e) => e.id)).toEqual(["b", "e"]);
  });

  it("lifts pinned entries to the top of their group, keeping order otherwise", () => {
    const groups = groupEntries([
      entry("a", "facts"),
      entry("b", "facts", true),
      entry("c", "facts"),
      entry("d", "facts", true),
    ]);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("returns one uncategorized group when nothing has a category", () => {
    const groups = groupEntries([entry("a", null), entry("b", null)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe(UNCATEGORIZED);
  });
});
