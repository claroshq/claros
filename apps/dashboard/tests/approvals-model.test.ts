import { describe, expect, it } from "vitest";
import { nextSelection, parseView, sharedFlowId } from "../src/approvals-model.js";

describe("nextSelection", () => {
  it("moves to the next row down", () => {
    expect(nextSelection(["a", "b", "c"], "b")).toBe("c");
  });
  it("moves up from the last row", () => {
    expect(nextSelection(["a", "b", "c"], "c")).toBe("b");
  });
  it("returns null when the last draft leaves", () => {
    expect(nextSelection(["a"], "a")).toBeNull();
  });
  it("falls back to the first row for an unknown id", () => {
    expect(nextSelection(["a", "b"], "x")).toBe("a");
    expect(nextSelection([], "x")).toBeNull();
  });
});

describe("parseView", () => {
  it("defaults to review", () => {
    expect(parseView(null)).toBe("review");
    expect(parseView("nonsense")).toBe("review");
  });
  it("accepts the other views", () => {
    expect(parseView("approved")).toBe("approved");
    expect(parseView("attention")).toBe("attention");
  });
});

describe("sharedFlowId", () => {
  it("returns the flow when every draft shares it", () => {
    expect(sharedFlowId(["f", "f"])).toBe("f");
  });
  it("returns null for mixed flows or no drafts", () => {
    expect(sharedFlowId(["f", "g"])).toBeNull();
    expect(sharedFlowId([])).toBeNull();
  });
});
