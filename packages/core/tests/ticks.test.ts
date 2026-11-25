import { describe, it, expect } from "vitest";
import { dueTicks, isPeriodicJob, tickName, TICK_INTERVAL_MINUTES, QUEUE } from "../src/index.js";

const at = (iso: string) => new Date(iso);

describe("dueTicks", () => {
  it("content generation is due at every 5-minute tick", () => {
    for (let m = 0; m < 60; m += 5) {
      const now = at(`2026-11-25T10:${String(m).padStart(2, "0")}:00Z`);
      expect(dueTicks(now)).toContain(QUEUE.CONTENT_GENERATION);
    }
  });

  it("scan, drain and counter rollover are due every 15 minutes", () => {
    for (let m = 0; m < 60; m += 5) {
      const due = dueTicks(at(`2026-11-25T10:${String(m).padStart(2, "0")}:00Z`));
      const expected = m % 15 === 0;
      expect(due.includes(QUEUE.SCAN)).toBe(expected);
      expect(due.includes(QUEUE.DRAIN)).toBe(expected);
      expect(due.includes(QUEUE.COUNTER_ROLLOVER)).toBe(expected);
    }
  });

  it("reap is due hourly at :00 only", () => {
    expect(dueTicks(at("2026-11-25T10:00:00Z"))).toContain(QUEUE.REAP);
    expect(dueTicks(at("2026-11-25T10:15:00Z"))).not.toContain(QUEUE.REAP);
    expect(dueTicks(at("2026-11-25T10:30:00Z"))).not.toContain(QUEUE.REAP);
  });

  it("grid snapshot is due once a day, on the 00:15 UTC tick", () => {
    const hits: string[] = [];
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 5) {
        const iso = `2026-11-25T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
        if (dueTicks(at(iso)).includes(QUEUE.GRID_SNAPSHOT)) hits.push(iso);
      }
    }
    expect(hits).toEqual(["2026-11-25T00:15:00Z"]);
  });

  it("the alerts digest is due once a day, on the 07:00 UTC tick", () => {
    const hits: string[] = [];
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 5) {
        const iso = `2026-11-25T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
        if (dueTicks(at(iso)).includes(QUEUE.ALERTS_DIGEST)) hits.push(iso);
      }
    }
    expect(hits).toEqual(["2026-11-25T07:00:00Z"]);
  });

  it("every periodic job has an interval for the late-tick check", () => {
    for (const q of [
      QUEUE.SCAN,
      QUEUE.DRAIN,
      QUEUE.REAP,
      QUEUE.COUNTER_ROLLOVER,
      QUEUE.PARTITION_MAINTENANCE,
      QUEUE.CONTENT_GENERATION,
      QUEUE.GRID_SNAPSHOT,
      QUEUE.ALERTS_DIGEST,
      QUEUE.WEBHOOK_DELIVERY,
    ]) {
      expect(isPeriodicJob(q)).toBe(true);
      expect(TICK_INTERVAL_MINUTES[q]).toBeGreaterThan(0);
    }
    expect(isPeriodicJob(QUEUE.DRAIN_MESSAGE)).toBe(false);
    expect(tickName(QUEUE.CONTENT_GENERATION)).toBe("content-generation");
  });

  it("partition maintenance is never due (Postgres only)", () => {
    for (let m = 0; m < 60; m += 5) {
      expect(dueTicks(at(`2026-11-25T00:${String(m).padStart(2, "0")}:00Z`))).not.toContain(
        QUEUE.PARTITION_MAINTENANCE,
      );
    }
  });

  it("a late trigger counts as its 5-minute slot", () => {
    expect(dueTicks(at("2026-11-25T00:17:42Z"))).toEqual(dueTicks(at("2026-11-25T00:15:00Z")));
    expect(dueTicks(at("2026-11-25T11:00:59Z"))).toEqual(dueTicks(at("2026-11-25T11:00:00Z")));
  });

  it("uses UTC, not the local time zone", () => {
    // 00:15 UTC is a different local hour almost everywhere; the result must not depend on it.
    expect(dueTicks(new Date(Date.UTC(2026, 10, 25, 0, 15)))).toContain(QUEUE.GRID_SNAPSHOT);
  });

  it("a 15-minute tick returns exactly the expected set", () => {
    expect(dueTicks(at("2026-11-25T10:45:00Z")).sort()).toEqual(
      [QUEUE.CONTENT_GENERATION, QUEUE.WEBHOOK_DELIVERY, QUEUE.SCAN, QUEUE.DRAIN, QUEUE.COUNTER_ROLLOVER].sort(),
    );
    expect(dueTicks(at("2026-11-25T10:05:00Z"))).toEqual([QUEUE.CONTENT_GENERATION, QUEUE.WEBHOOK_DELIVERY]);
  });
});
