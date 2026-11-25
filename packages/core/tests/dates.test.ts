import { describe, it, expect } from "vitest";
import {
  parseDateTrigger,
  parseDateValue,
  totalSlots,
  slotDue,
  firstOpenSlot,
  atLocalTime,
  anchorWindow,
  stepForSlot,
  durationMs,
  clarosConfigSchema,
  stepConditionSchema,
  compiledStepSchema,
  planConfig,
} from "../src/index.js";

const DAY = 86_400_000;

describe("date triggers (G3)", () => {
  const schedule = parseDateTrigger("date_schedule", { anchor: "first_paid_at", offsets: ["1d", "3d", "7d", "14d", "30d"], repeat: "30d", max_sends: 7 })!;

  it("parses both trigger types and rejects bad configs", () => {
    expect(parseDateTrigger("date_property", { property: "trial_ends_at", offset: "-3d" })).toMatchObject({ type: "date_property" });
    expect(parseDateTrigger("date_property", { property: "trial_ends_at", offset: "3 days" })).toBeNull();
    expect(parseDateTrigger("date_schedule", { anchor: "a", offsets: ["3d", "1d"], max_sends: 2 })).toBeNull();
    expect(parseDateTrigger("event", {})).toBeNull();
    expect(durationMs("-3d")).toBe(-3 * DAY);
  });

  it("computes slots with repeat and max_sends", () => {
    expect(totalSlots(schedule)).toBe(7);
    const anchor = new Date("2026-01-01T00:00:00Z");
    const days = [1, 2, 3, 4, 5, 6, 7].map((k) => (slotDue(schedule, anchor, k, "UTC")!.getTime() - anchor.getTime()) / DAY);
    expect(days).toEqual([1, 3, 7, 14, 30, 60, 90]);
    expect(slotDue(schedule, anchor, 8, "UTC")).toBeNull();
    const noRepeat = parseDateTrigger("date_schedule", { anchor: "a", offsets: ["1d", "2d"], max_sends: 9 })!;
    expect(totalSlots(noRepeat)).toBe(2);
  });

  it("finds the first open slot within the grace window", () => {
    const anchor = new Date("2026-01-01T00:00:00Z");
    expect(firstOpenSlot(schedule, anchor, new Date(anchor.getTime() + 5 * DAY), "UTC")!.slot).toBe(3);
    expect(firstOpenSlot(schedule, anchor, new Date(anchor.getTime() + 500 * DAY), "UTC")).toBeNull();
    const w = anchorWindow(schedule, new Date(anchor.getTime() + 5 * DAY));
    expect(w.from.getTime()).toBeLessThan(anchor.getTime());
    expect(w.to.getTime()).toBeGreaterThan(anchor.getTime());
  });

  it("send_at_local lands on the local time of the local day, across DST", () => {
    expect(atLocalTime(new Date("2026-12-09T20:00:00Z"), "09:00", "America/New_York").toISOString()).toBe("2026-12-09T14:00:00.000Z");
    expect(atLocalTime(new Date("2026-07-09T20:00:00Z"), "09:00", "America/New_York").toISOString()).toBe("2026-07-09T13:00:00.000Z");
    expect(atLocalTime(new Date("2026-07-09T23:30:00Z"), "08:15", "Asia/Tokyo").toISOString()).toBe("2026-07-09T23:15:00.000Z");
  });

  it("parses date values", () => {
    expect(parseDateValue("2026-02-03")?.toISOString()).toBe("2026-02-03T00:00:00.000Z");
    expect(parseDateValue(1_767_225_600)?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(parseDateValue(1_767_225_600_000)?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(parseDateValue("tomorrow")).toBeNull();
    expect(parseDateValue(null)).toBeNull();
  });

  it("picks the step for a slot", () => {
    const steps = [{ order: 1 }, { order: 3 }];
    expect(stepForSlot(steps, 1)!.order).toBe(1);
    expect(stepForSlot(steps, 2)!.order).toBe(1);
    expect(stepForSlot(steps, 9)!.order).toBe(3);
  });

  it("config documents accept date triggers, date_unchanged and expires_after", () => {
    const ok = clarosConfigSchema.safeParse({
      flows: [
        {
          slug: "trial_ending",
          name: "Trial ending",
          trigger: { type: "date_property", property: "trial_ends_at", offset: "-3d", send_at_local: "09:00" },
          steps: [{ order: 1, action_type: "trial_ending", delay: "0m", template_ref: "t", condition: { date_unchanged: true }, expires_after: "2d" }],
        },
      ],
    });
    expect(ok.success).toBe(true);
    const bad = clarosConfigSchema.safeParse({
      flows: [{ slug: "x", name: "x", trigger: { type: "date_schedule", anchor: "a", offsets: [] , max_sends: 1 }, steps: [{ order: 1, action_type: "a", delay: "0m" }] }],
    });
    expect(bad.success).toBe(false);
    expect(stepConditionSchema.safeParse({ date_unchanged: true }).success).toBe(true);
    expect(compiledStepSchema.safeParse({ order: 1, action_type: "a", delay: "0m", expires_after: "soon" }).success).toBe(false);
  });

  it("config apply refuses a choose step for a product without an LLM", () => {
    const doc = clarosConfigSchema.parse({
      flows: [{ slug: "n", name: "N", trigger: { type: "event", event: "e" }, steps: [{ order: 1, action_type: "nurture", delay: "0m", type: "choose", candidates: [{ action_type: "tip" }] }] }],
    });
    const state = { settings: {}, locale: null, configVersion: 0, topics: [], templates: [], flows: [], transports: [], endpoints: [] };
    const deps = { newId: () => "id", newSecret: () => "s", readSecret: () => null };
    expect(planConfig(doc, { ...state, hasLlm: false }, deps).errors.join()).toContain("needs an LLM");
    expect(planConfig(doc, { ...state, hasLlm: true }, deps).errors).toEqual([]);
    expect(clarosConfigSchema.safeParse({ flows: [{ slug: "n", name: "N", trigger: { type: "event", event: "e" }, steps: [{ order: 1, action_type: "a", delay: "0m", type: "choose" }] }] }).success).toBe(false);
  });
});

