/**
 * Tests for @claros/scheduler: startScheduler cron registration pattern.
 *
 * Covers the one schedule defined in task 5 (SCAN every 15 min). Pattern
 * tests confirm:
 * - startScheduler calls boss.schedule() for every cron-triggered queue
 * - SCAN is scheduled at the correct cron expression
 * - startScheduler never calls boss.work() (handler registration is the worker's job)
 * - the call is idempotent (pg-boss schedule() is an upsert)
 *
 * QUEUE is imported from @claros/core. Scheduler has no dependency on
 * @claros/worker - the queue name string is the only coupling.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QUEUE } from "@claros/core";
import { CLAROS_SCHEDULER_VERSION, startScheduler } from "../src/index.js";

// ---------------------------------------------------------------------------
// pg-boss mock
// ---------------------------------------------------------------------------

const schedules: Array<{ queue: string; cron: string; data: unknown }> = [];
let workCalls = 0;

const mockBoss = {
  schedule: vi.fn(async (name: string, cron: string, data: unknown) => {
    schedules.push({ queue: name, cron, data });
  }),
  work: vi.fn(async () => {
    workCalls++;
  }),
};

vi.mock("pg-boss", async () => {
  const actual = await vi.importActual<typeof import("pg-boss")>("pg-boss");
  return { ...actual, default: vi.fn().mockImplementation(() => mockBoss) };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("@claros/scheduler - version", () => {
  it("exports version", () => {
    expect(CLAROS_SCHEDULER_VERSION).toBe("0.0.0");
  });
});

describe("startScheduler - registration pattern", () => {
  beforeEach(() => {
    schedules.length = 0;
    workCalls = 0;
    vi.clearAllMocks();
    mockBoss.schedule.mockImplementation(async (name: string, cron: string, data: unknown) => {
      schedules.push({ queue: name, cron, data });
    });
    mockBoss.work.mockImplementation(async () => {
      workCalls++;
    });
  });

  it("registers a schedule for QUEUE.SCAN", async () => {
    await startScheduler(mockBoss as never);
    expect(schedules.find((s) => s.queue === QUEUE.SCAN)).toBeDefined();
  });

  it("registers a schedule for QUEUE.DRAIN", async () => {
    await startScheduler(mockBoss as never);
    expect(schedules.find((s) => s.queue === QUEUE.DRAIN)).toBeDefined();
  });

  it("registers a schedule for QUEUE.REAP", async () => {
    await startScheduler(mockBoss as never);
    expect(schedules.find((s) => s.queue === QUEUE.REAP)).toBeDefined();
  });

  it("SCAN is scheduled with cron every-15 * * * *", async () => {
    await startScheduler(mockBoss as never);
    const entry = schedules.find((s) => s.queue === QUEUE.SCAN)!;
    expect(entry.cron).toBe("*/15 * * * *");
  });

  it("DRAIN is scheduled with cron every-15 * * * *", async () => {
    await startScheduler(mockBoss as never);
    const entry = schedules.find((s) => s.queue === QUEUE.DRAIN)!;
    expect(entry.cron).toBe("*/15 * * * *");
  });

  it("REAP is scheduled with cron 0 * * * * (top of every hour)", async () => {
    await startScheduler(mockBoss as never);
    const entry = schedules.find((s) => s.queue === QUEUE.REAP)!;
    expect(entry.cron).toBe("0 * * * *");
  });

  it("registers a schedule for QUEUE.CONTENT_GENERATION", async () => {
    await startScheduler(mockBoss as never);
    expect(schedules.find((s) => s.queue === QUEUE.CONTENT_GENERATION)).toBeDefined();
  });

  it("CONTENT_GENERATION is scheduled with cron every 5 min", async () => {
    await startScheduler(mockBoss as never);
    const entry = schedules.find((s) => s.queue === QUEUE.CONTENT_GENERATION)!;
    expect(entry.cron).toBe("*/5 * * * *");
  });

  it("ALERTS_DIGEST is scheduled daily at 07:00 UTC", async () => {
    await startScheduler(mockBoss as never);
    expect(schedules.find((s) => s.queue === QUEUE.ALERTS_DIGEST)?.cron).toBe("0 7 * * *");
  });

  it("registers exactly as many schedules as there are cron-triggered queues", async () => {
    await startScheduler(mockBoss as never);
    // Nine cron schedules: SCAN + DRAIN + REAP + COUNTER_ROLLOVER + PARTITION_MAINTENANCE + CONTENT_GENERATION
    // + GRID_SNAPSHOT + ALERTS_DIGEST + WEBHOOK_DELIVERY.
    expect(schedules).toHaveLength(9);
  });

  it("does NOT call boss.work()", async () => {
    await startScheduler(mockBoss as never);
    expect(workCalls).toBe(0);
    expect(mockBoss.work).not.toHaveBeenCalled();
  });

  it("resolves without throwing", async () => {
    await expect(startScheduler(mockBoss as never)).resolves.toBeUndefined();
  });

  it("is idempotent - second call resolves without throwing", async () => {
    await startScheduler(mockBoss as never);
    await expect(startScheduler(mockBoss as never)).resolves.toBeUndefined();
  });
});
