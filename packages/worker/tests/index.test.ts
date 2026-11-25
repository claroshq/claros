/**
 * Tests for @claros/worker: createBoss factory and startWorker registration pattern.
 *
 * Covers the queues defined in tasks 5 and 11 (SCAN, COMPILE). Pattern tests confirm:
 * - createBoss returns a usable instance without throwing
 * - startWorker registers exactly the queues defined in QUEUE
 * - the registered handler resolves without throwing (stub behavior)
 * - a throwing handler propagates its error (pg-boss uses this to call fail())
 * - fromDrizzle is re-exported for transactional job enqueue in API routes
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QUEUE } from "@claros/core";
import { CLAROS_WORKER_VERSION, startWorker, createBoss, fromDrizzle } from "../src/index.js";

// ---------------------------------------------------------------------------
// pg-boss mock
// ---------------------------------------------------------------------------

const registrations: Array<{
  queue: string;
  handler: (jobs: Array<{ id: string; name: string; data: unknown }>) => Promise<void>;
}> = [];

const mockBoss = {
  createQueue: vi.fn(async (_name: string) => undefined),
  work: vi.fn(
    async (
      name: string,
      _opts: unknown,
      handler: (jobs: Array<{ id: string; name: string; data: unknown }>) => Promise<void>,
    ) => {
      registrations.push({ queue: name, handler });
      return `worker-id-${name}`;
    },
  ),
};

vi.mock("pg-boss", async () => {
  const actual = await vi.importActual<typeof import("pg-boss")>("pg-boss");
  const MockPgBoss = vi.fn().mockImplementation(() => mockBoss);
  return { ...actual, PgBoss: MockPgBoss };
});

// Mock db (not used by SCAN handler in unit mode, but required by startWorker signature)
// The scan handler calls phaseTimeTransitions(db, now) which queries tenants table.
// In this unit test, we mock the module to prevent actual DB calls.
const mockDb = {} as never;

// Mock scan-time-transitions module to avoid DB calls in unit tests
vi.mock("../src/scan-time-transitions.js", () => ({
  phaseTimeTransitions: vi.fn(async () => ({
    tenantsProcessed: 0,
    contactsEvaluated: 0,
    transitionsApplied: 0,
    appliedTransitions: [],
  })),
}));

// Mock scan-enrollment module to avoid DB calls in unit tests
vi.mock("../src/scan-enrollment.js", () => ({
  phaseEnrollment: vi.fn(async () => ({
    transitionsEvaluated: 0,
    enrollmentsAttempted: 0,
    enrollmentsSucceeded: 0,
    evictions: 0,
  })),
}));

// Mock scan-segment-enrollment module to avoid DB calls in unit tests
vi.mock("../src/scan-segment-enrollment.js", () => ({
  phaseSegmentEnrollment: vi.fn(async () => ({
    tenantsProcessed: 0,
    flowsEvaluated: 0,
    enrollmentsAttempted: 0,
    enrollmentsSucceeded: 0,
    flowsCapped: 0,
  })),
}));

// Mock scan-step-advancement module to avoid DB calls in unit tests
vi.mock("../src/scan-step-advancement.js", () => ({
  phaseStepAdvancement: vi.fn(async () => ({
    tenantsProcessed: 0,
    membershipsEvaluated: 0,
    messagesCreated: 0,
    stepsAdvanced: 0,
    membershipsCompleted: 0,
    membershipsExitedArchived: 0,
    membershipsSkippedPaused: 0,
    staleCheckpointsDiscarded: 0,
  })),
}));

// Mock scan-engagement-depth module to avoid DB calls in unit tests
vi.mock("../src/scan-engagement-depth.js", () => ({
  phaseEngagementDepth: vi.fn(async () => ({
    tenantsProcessed: 0,
    contactsUpdated: 0,
    contactsUnchanged: 0,
  })),
}));

// Mock trigger-check module to avoid DB calls in unit tests
vi.mock("../src/trigger-check.js", () => ({
  handleTriggerCheck: vi.fn(async () => undefined),
}));

// Mock drain module to avoid DB calls in unit tests
vi.mock("../src/drain.js", () => ({
  processDrainTick: vi.fn(async () => ({
    candidatesFetched: 0,
    skippedNoTransport: 0,
    skippedNoEmail: 0,
    sent: 0,
    suppressed: 0,
    deferredFrequency: 0,
    deferredWindow: 0,
    transportErrors: 0,
  })),
  fetchDrainBatchSimple: vi.fn(async () => []),
}));

// Mock reap module to avoid DB calls in unit tests
vi.mock("../src/reap.js", () => ({
  processReapTick: vi.fn(async () => ({
    sendingRetried: 0,
    sendingFailed: 0,
    generatingRetried: 0,
    generatingFailed: 0,
  })),
}));

// Mock content module to avoid DB calls in unit tests
vi.mock("../src/content.js", () => ({
  processContentTick: vi.fn(async () => ({
    claimed: 0,
    advanced: 0,
    skipped: 0,
    errors: 0,
  })),
}));

// Mock the alerts module (heartbeats, ops events) to avoid DB calls in unit tests
const recordDeadLetter = vi.fn(async () => undefined);
vi.mock("../src/alerts.js", () => ({
  recordJobFailure: vi.fn(async () => undefined),
  recordDeadLetter: (...args: unknown[]) => recordDeadLetter(...(args as [])),
  recordTickRun: vi.fn(async () => undefined),
  recordDrainFaults: vi.fn(async () => undefined),
  checkSendErrors: vi.fn(async () => undefined),
  recordLlmCalls: vi.fn(async () => undefined),
  runAlertTick: vi.fn(async () => ({ lateTicks: [], resolved: 0, mailed: 0, storm: false })),
  runDigest: vi.fn(async () => ({ sent: false, deletedEvents: 0 })),
}));

// Mock transport module to avoid import issues in unit tests
vi.mock("../src/transport.js", () => ({
  nullTransportResolver: vi.fn(async () => null),
}));

// Mock embed-kb module to avoid fetch calls in unit tests
vi.mock("../src/embed-kb.js", () => ({
  handleKbEmbedJob: vi.fn(async () => undefined),
  EMBEDDING_MAX_CHARS: 32_000,
  DEFAULT_EMBEDDING_MODEL: "text-embedding-3-small",
  EmbeddingPermanentError: class EmbeddingPermanentError extends Error {},
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("@claros/worker - version", () => {
  it("exports version", () => {
    expect(CLAROS_WORKER_VERSION).toBe("0.0.0");
  });
});

describe("createBoss", () => {
  it("returns an object with a work method (PgBoss-compatible)", () => {
    const boss = createBoss("postgres://localhost/test");
    expect(boss).toBeDefined();
    expect(typeof (boss as typeof mockBoss).work).toBe("function");
  });

  it("accepts schedule:false without throwing", () => {
    expect(() => createBoss("postgres://localhost/test", { schedule: false })).not.toThrow();
  });
});

describe("startWorker - registration pattern", () => {
  beforeEach(() => {
    registrations.length = 0;
    vi.clearAllMocks();
    mockBoss.createQueue.mockImplementation(async (_name: string) => undefined);
    mockBoss.work.mockImplementation(
      async (
        name: string,
        _opts: unknown,
        handler: (jobs: Array<{ id: string; name: string; data: unknown }>) => Promise<void>,
      ) => {
        registrations.push({ queue: name, handler });
        return `worker-id-${name}`;
      },
    );
  });

  it("registers a handler for every QUEUE constant", async () => {
    await startWorker(mockBoss as never, mockDb);
    const registered = new Set(registrations.map((r) => r.queue));
    for (const name of Object.values(QUEUE)) {
      expect(registered, `missing handler for ${name}`).toContain(name);
    }
  });

  it("registers exactly as many handlers as QUEUE has entries", async () => {
    await startWorker(mockBoss as never, mockDb);
    expect(registrations).toHaveLength(Object.keys(QUEUE).length);
  });

  it("no unrecognised queue names are registered", async () => {
    await startWorker(mockBoss as never, mockDb);
    const known = new Set(Object.values(QUEUE));
    for (const { queue } of registrations) {
      expect(known, `unexpected registration: ${queue}`).toContain(queue);
    }
  });

  it("SCAN handler resolves without throwing", async () => {
    await startWorker(mockBoss as never, mockDb);
    const reg = registrations.find((r) => r.queue === QUEUE.SCAN)!;
    expect(reg).toBeDefined();
    await expect(
      reg.handler([{ id: "j1", name: QUEUE.SCAN, data: {} }]),
    ).resolves.toBeUndefined();
  });
});

describe("failure path", () => {
  it("a throwing handler propagates its error (pg-boss calls fail() on throw)", async () => {
    const throwing = async (_jobs: unknown[]) => {
      throw new Error("simulated handler failure");
    };
    await expect(throwing([{ id: "j", name: "test", data: {} }])).rejects.toThrow(
      "simulated handler failure",
    );
  });

  it("startWorker does not throw when boss.work resolves normally", async () => {
    registrations.length = 0;
    vi.clearAllMocks();
    mockBoss.createQueue.mockImplementation(async (_name: string) => undefined);
    mockBoss.work.mockImplementation(async (name: string, _opts: unknown, handler: never) => {
      registrations.push({ queue: name, handler });
    });
    await expect(startWorker(mockBoss as never, mockDb)).resolves.toBeUndefined();
  });
});

describe("dead letters (pg-boss retries exhausted)", () => {
  beforeEach(() => {
    registrations.length = 0;
    recordDeadLetter.mockClear();
    mockBoss.work.mockImplementation(async (name: string, _opts: unknown, handler: never) => {
      registrations.push({ queue: name, handler });
      return `worker-id-${name}`;
    });
  });

  it("registers handlers with job metadata", async () => {
    await startWorker(mockBoss as never, mockDb);
    const opts = mockBoss.work.mock.calls.map((c) => c[1] as { includeMetadata?: boolean });
    expect(opts.every((o) => o.includeMetadata === true)).toBe(true);
  });

  it("records a dead letter when the last attempt fails, not before", async () => {
    await startWorker(mockBoss as never, mockDb);
    const reg = registrations.find((r) => r.queue === QUEUE.COMPILE)!;
    const job = (retryCount: number) => ({ id: "j", name: QUEUE.COMPILE, data: { flow_id: "nope" }, retryCount, retryLimit: 2 });
    // COMPILE without a real flow throws in the (unmocked) compile handler.
    await expect(reg.handler([job(0)] as never)).rejects.toThrow();
    expect(recordDeadLetter).not.toHaveBeenCalled();
    await expect(reg.handler([job(2)] as never)).rejects.toThrow();
    expect(recordDeadLetter).toHaveBeenCalledTimes(1);
    expect(recordDeadLetter.mock.calls[0]).toEqual([mockDb, QUEUE.COMPILE, { flow_id: "nope" }, 3, expect.any(Error)]);
  });
});

describe("fromDrizzle re-export", () => {
  it("fromDrizzle is a function exported from @claros/worker", () => {
    expect(typeof fromDrizzle).toBe("function");
  });
});
