import { describe, it, expect } from "vitest";
import { dayLabel, dayDetail, groupByDay } from "../src/day-groups.js";
import { pageItems } from "../src/components/pagination.js";

// Friday, Nov 27 2026, 15:00 local time.
const now = new Date(2026, 10, 27, 15, 0);
const at = (day: number, hour = 12, month = 10, year = 2026) => new Date(year, month, day, hour);

describe("dayLabel", () => {
  it("names today, yesterday and the last week's weekdays", () => {
    expect(dayLabel(at(27, 0), now)).toBe("Today");
    expect(dayLabel(at(26, 23), now)).toBe("Yesterday");
    expect(dayLabel(at(25), now)).toBe("Wednesday");
    expect(dayLabel(at(21), now)).toBe("Saturday");
  });
  it("falls back to a date, with the year when it differs", () => {
    expect(dayLabel(at(20), now)).toBe("Nov 20");
    expect(dayLabel(at(30, 12, 11, 2025), now)).toBe("Dec 30, 2025");
  });
  it("gives the full date beside relative labels only", () => {
    expect(dayDetail(at(27), now)).toBe("Friday, Nov 27");
    expect(dayDetail(at(25), now)).toBe("Nov 25");
    expect(dayDetail(at(20), now)).toBeNull();
  });
});

describe("groupByDay", () => {
  it("groups consecutive rows by local day and keeps rows without a time apart", () => {
    const rows = [at(27, 14), at(27, 9), at(26, 22), at(20), null, null].map((t, i) => ({
      i,
      t: t?.toISOString() ?? null,
    }));
    const groups = groupByDay(rows, (r) => r.t, "Not sent", now);
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.i)])).toEqual([
      ["Today", [0, 1]],
      ["Yesterday", [2]],
      ["Nov 20", [3]],
      ["Not sent", [4, 5]],
    ]);
  });
});

describe("pageItems", () => {
  it("lists every page up to seven", () => {
    expect(pageItems(1, 1)).toEqual([1]);
    expect(pageItems(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it("collapses long ranges around the current page", () => {
    expect(pageItems(1, 20)).toEqual([1, 2, 3, 4, 5, null, 20]);
    expect(pageItems(10, 20)).toEqual([1, null, 9, 10, 11, null, 20]);
    expect(pageItems(20, 20)).toEqual([1, null, 16, 17, 18, 19, 20]);
    expect(pageItems(5, 20)).toEqual([1, null, 4, 5, 6, null, 20]);
  });
});
