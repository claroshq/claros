import { describe, expect, it } from "vitest";
import { isRepeatClick } from "../src/lib/double-click-guard.js";

/** A minimal element: `closest` walks up through `parent`. */
function el(matches: boolean, attrs: string[] = [], parent: ReturnType<typeof el> | null = null) {
  const node = {
    hasAttribute: (name: string) => attrs.includes(name),
    closest: (_selector: string): typeof node | null => (matches ? node : parent ? parent.closest(_selector) : null),
  };
  return node;
}

const click = (detail: number, target: unknown) => ({ detail, target: target as EventTarget });

describe("isRepeatClick", () => {
  it("lets the first click through", () => {
    expect(isRepeatClick(click(1, el(true)))).toBe(false);
  });

  it("lets keyboard activation through (detail 0)", () => {
    expect(isRepeatClick(click(0, el(true)))).toBe(false);
  });

  it("drops the second and third click of a multi-click on a button", () => {
    expect(isRepeatClick(click(2, el(true)))).toBe(true);
    expect(isRepeatClick(click(3, el(true)))).toBe(true);
  });

  it("drops a repeat click on an icon inside a button", () => {
    const button = el(true);
    const icon = el(false, [], button);
    expect(isRepeatClick(click(2, icon))).toBe(true);
  });

  it("lets repeat clicks through on a button marked data-repeatable", () => {
    expect(isRepeatClick(click(2, el(true, ["data-repeatable"])))).toBe(false);
  });

  it("ignores clicks outside buttons", () => {
    expect(isRepeatClick(click(2, el(false)))).toBe(false);
    expect(isRepeatClick(click(2, null))).toBe(false);
    expect(isRepeatClick(click(2, {}))).toBe(false);
  });
});
