/**
 * People list state: URL params, sort defaults, date presets and API filters.
 */
import { describe, it, expect } from "vitest";
import {
  clearedQuery,
  dateRange,
  effectiveSort,
  isFiltering,
  nextSort,
  readPeopleQuery,
  toContactFilters,
  writePeopleQuery,
} from "../src/lib/people-query.js";

const q = (s: string) => readPeopleQuery(new URLSearchParams(s));
// Wednesday 2026-03-18, 15:30 local time
const NOW = new Date(2026, 2, 18, 15, 30);
const localMidnight = (y: number, m: number, d: number) => new Date(y, m - 1, d).toISOString();

describe("readPeopleQuery", () => {
  it("reads known values and ignores unknown ones", () => {
    const r = q("q=ada&state=engaged&depth=power&payment=past_due&letter=B&date=30d&date_field=last_seen&sort=name&order=desc");
    expect(r).toMatchObject({
      search: "ada",
      state: "engaged",
      depth: "power",
      payment: "past_due",
      letter: "b",
      datePreset: "30d",
      dateField: "last_seen",
      sort: "name",
      order: "desc",
    });
    const junk = q("state=bogus&payment=gold&letter=ab&date=forever&date_field=birthday&sort=email&order=up&from=nope");
    expect(junk).toMatchObject({
      state: null,
      payment: null,
      letter: null,
      datePreset: null,
      dateField: "joined",
      sort: null,
      order: null,
      dateFrom: null,
    });
  });

  it("accepts # as a letter and keeps retention-grid buckets", () => {
    expect(q("letter=%23").letter).toBe("#");
    expect(q("tenure_bucket=loyal&recency_bucket=idle")).toMatchObject({ tenure: "loyal", recency: "idle" });
  });
});

describe("writePeopleQuery", () => {
  it("sets, replaces and removes params, keeping the rest", () => {
    const prev = new URLSearchParams("tenure_bucket=new&state=engaged");
    const next = writePeopleQuery(prev, { state: null, payment: "paid", letter: "c", dateField: "joined" });
    expect(next.get("tenure_bucket")).toBe("new");
    expect(next.has("state")).toBe(false);
    expect(next.get("payment")).toBe("paid");
    expect(next.get("letter")).toBe("c");
    // joined is the default date field and stays out of the URL
    expect(next.has("date_field")).toBe(false);
    expect(writePeopleQuery(next, { dateField: "last_seen" }).get("date_field")).toBe("last_seen");
  });

  it("round-trips through readPeopleQuery", () => {
    const params = writePeopleQuery(new URLSearchParams(), {
      search: "x",
      datePreset: "custom",
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      sort: "last_seen",
      order: "asc",
    });
    expect(readPeopleQuery(params)).toMatchObject({
      search: "x",
      datePreset: "custom",
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      sort: "last_seen",
      order: "asc",
    });
  });
});

describe("sorting", () => {
  it("defaults to latest joined, or A to Z while a letter is picked", () => {
    expect(effectiveSort(q(""))).toEqual({ key: "joined", order: "desc" });
    expect(effectiveSort(q("letter=m"))).toEqual({ key: "name", order: "asc" });
    expect(effectiveSort(q("letter=m&sort=last_seen"))).toEqual({ key: "last_seen", order: "desc" });
    expect(effectiveSort(q("sort=joined&order=asc"))).toEqual({ key: "joined", order: "asc" });
  });

  it("flips the active column and starts others in their natural direction", () => {
    expect(nextSort(q(""), "joined")).toEqual({ sort: "joined", order: "asc" });
    expect(nextSort(q("sort=joined&order=asc"), "joined")).toEqual({ sort: "joined", order: "desc" });
    expect(nextSort(q(""), "name")).toEqual({ sort: "name", order: "asc" });
    expect(nextSort(q(""), "last_seen")).toEqual({ sort: "last_seen", order: "desc" });
    expect(nextSort(q("letter=a"), "name")).toEqual({ sort: "name", order: "desc" });
  });
});

describe("dateRange", () => {
  it("counts presets in whole local days including today", () => {
    expect(dateRange(q("date=7d"), NOW)).toEqual({ after: localMidnight(2026, 3, 12) });
    expect(dateRange(q("date=30d"), NOW)).toEqual({ after: localMidnight(2026, 2, 17) });
    expect(dateRange(q("date=12m"), NOW)).toEqual({ after: localMidnight(2025, 3, 19) });
    expect(dateRange(q("date=over30d"), NOW)).toEqual({ before: localMidnight(2026, 2, 16) });
    expect(dateRange(q("date=over90d"), NOW)).toEqual({ before: localMidnight(2025, 12, 18) });
    expect(dateRange(q(""), NOW)).toEqual({});
  });

  it("includes both end days of a custom range, and either end may be open", () => {
    expect(dateRange(q("date=custom&from=2026-01-01&to=2026-01-31"), NOW)).toEqual({
      after: localMidnight(2026, 1, 1),
      before: localMidnight(2026, 2, 1),
    });
    expect(dateRange(q("date=custom&to=2026-01-31"), NOW)).toEqual({ before: localMidnight(2026, 2, 1) });
    expect(dateRange(q("date=custom"), NOW)).toEqual({});
  });
});

describe("toContactFilters", () => {
  it("maps the state to GET /v1/contacts filters", () => {
    expect(toContactFilters(q("state=at_risk&payment=trial&letter=k&date=7d"), "ada", NOW)).toEqual({
      search: "ada",
      lifecycle_state: "at_risk",
      payment_status: "trial",
      letter: "k",
      joined_after: localMidnight(2026, 3, 12),
      sort: "name",
      order: "asc",
    });
  });

  it("sends the date range on the chosen field", () => {
    const f = toContactFilters(q("date_field=last_seen&date=over30d&tenure_bucket=new"), "", NOW);
    expect(f).toEqual({
      tenure_bucket: "new",
      last_seen_before: localMidnight(2026, 2, 16),
      sort: "joined",
      order: "desc",
    });
  });
});

describe("filtering and clearing", () => {
  it("treats sort alone as not filtering", () => {
    expect(isFiltering(q("sort=name&order=desc"))).toBe(false);
    expect(isFiltering(q("q=%20%20"))).toBe(false);
    expect(isFiltering(q("letter=a"))).toBe(true);
    expect(isFiltering(q("payment=paid"))).toBe(true);
    expect(isFiltering(q("date=7d"))).toBe(true);
    expect(isFiltering(q("recency_bucket=idle"))).toBe(true);
  });

  it("clears every filter and keeps the sort", () => {
    const cleared = clearedQuery(new URLSearchParams("q=x&letter=a&payment=paid&date=7d&sort=name&order=desc"));
    expect(cleared.toString()).toBe("sort=name&order=desc");
  });
});
