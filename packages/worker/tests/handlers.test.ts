/**
 * Unit tests for runJob(), the runtime-neutral job dispatcher shared by the
 * pg-boss workers (Node) and the Queues consumer (Cloudflare Workers).
 *
 * Every handler module is mocked: the tests check routing, the follow-up
 * jobs each handler chains through deps.enqueue, the transport seam, and
 * that failures propagate (so the runtime retries).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QUEUE } from "@claros/core";

const { calls, record, mocks } = vi.hoisted(() => {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const record = (fn: string, result: unknown = undefined) =>
    vi.fn(async (...args: unknown[]) => {
      calls.push({ fn, args });
      return result;
    });
  const mocks = {
    triggerCheckResult: { enrolledMembershipIds: [] as string[] },
    advanceResult: { messageCreated: false, messageId: null as string | null, advanced: false, completed: false, exited: false },
    processResult: { claimed: false, outcome: "skipped" },
  };
  return { calls, record, mocks };
});

vi.mock("../src/compile.js", () => ({ handleCompileJob: record("compile") }));
vi.mock("../src/embed-kb.js", () => ({
  handleKbEmbedJob: record("kbEmbed"),
  EMBEDDING_MAX_CHARS: 32_000,
  DEFAULT_EMBEDDING_MODEL: "text-embedding-3-small",
}));
vi.mock("../src/scan-time-transitions.js", () => ({
  phaseTimeTransitions: record("timeTransitions", {
    tenantsProcessed: 0,
    contactsEvaluated: 0,
    transitionsApplied: 0,
    appliedTransitions: [],
  }),
}));
vi.mock("../src/scan-enrollment.js", () => ({ phaseEnrollment: record("enrollment") }));
vi.mock("../src/scan-segment-enrollment.js", () => ({
  phaseSegmentEnrollment: record("segmentEnrollment", { flowsEvaluated: 0, enrollmentsAttempted: 0, enrollmentsSucceeded: 0, flowsCapped: 0 }),
}));
vi.mock("../src/scan-step-advancement.js", () => ({
  phaseStepAdvancement: record("stepAdvancement", {
    tenantsProcessed: 0,
    membershipsEvaluated: 0,
    messagesCreated: 0,
    stepsAdvanced: 0,
    membershipsCompleted: 0,
    membershipsExitedArchived: 0,
  }),
}));
vi.mock("../src/scan-engagement-depth.js", () => ({
  phaseEngagementDepth: record("engagementDepth", { tenantsProcessed: 0, contactsUpdated: 0, contactsUnchanged: 0 }),
}));
vi.mock("../src/trigger-check.js", () => ({
  handleTriggerCheck: vi.fn(async (...args: unknown[]) => {
    calls.push({ fn: "triggerCheck", args });
    return mocks.triggerCheckResult;
  }),
}));
vi.mock("../src/drain.js", () => ({
  processDrainTick: record("drainTick", {
    candidatesFetched: 0,
    sent: 0,
    suppressed: 0,
    deferredFrequency: 0,
    deferredWindow: 0,
    skippedNoTransport: 0,
    transportErrors: 0,
  }),
  fetchDrainBatchSimple: vi.fn(),
}));
vi.mock("../src/reap.js", () => ({
  processReapTick: record("reap", {
    sendingRetried: 0,
    sendingFailed: 0,
    generatingRetried: 0,
    generatingFailed: 0,
    awaitingContentRetried: 0,
    awaitingContentFailed: 0,
  }),
}));
vi.mock("../src/counter-rollover.js", () => ({ processCounterRollover: record("counterRollover", { contactsRolled: 0 }) }));
vi.mock("../src/partition-maintenance.js", () => ({
  processPartitionMaintenance: record("partitionMaintenance", { partitionsCreated: [] }),
}));
vi.mock("../src/content.js", () => ({
  processContentTick: record("contentTick", { claimed: 0, advanced: 0, skipped: 0, valueGated: 0, errors: 0 }),
}));
vi.mock("../src/advance-membership.js", () => ({
  handleAdvanceMembership: vi.fn(async (...args: unknown[]) => {
    calls.push({ fn: "advanceMembership", args });
    return mocks.advanceResult;
  }),
}));
vi.mock("../src/process-message.js", () => ({
  handleProcessMessage: vi.fn(async (...args: unknown[]) => {
    calls.push({ fn: "processMessage", args });
    return mocks.processResult;
  }),
}));
vi.mock("../src/drain-message.js", () => ({ handleDrainMessage: record("drainMessage", { claimed: false }) }));
vi.mock("../src/snapshot-retention-grid.js", () => ({
  processGridSnapshotTick: record("gridSnapshot", { tenantsProcessed: 0, rowsWritten: 0, snapshotDate: "2026-11-25" }),
}));
vi.mock("../src/transport-resolver.js", () => ({
  buildTenantTransportResolver: vi.fn(() => "tenant-resolver"),
}));
// The handlers entry must not load pg-boss (the Workers bundle imports it).
vi.mock("pg-boss", () => {
  throw new Error("pg-boss must not be imported by @claros/worker/handlers");
});
vi.mock("@claros/store", () => ({
  storeFor: () => ({ workerIndex: { getAnyTenantSettings: async () => null } }),
}));

import { runJob, type JobDeps } from "../src/handlers.js";

const db = { tag: "db" } as never;
let enqueued: Array<{ queue: string; data: unknown; opts: unknown }>;
let deps: JobDeps;

beforeEach(() => {
  calls.length = 0;
  enqueued = [];
  deps = {
    db,
    enqueue: async (queue, data, opts) => {
      enqueued.push({ queue, data, opts });
      return null;
    },
  };
  mocks.triggerCheckResult = { enrolledMembershipIds: [] };
  mocks.advanceResult = { messageCreated: false, messageId: null, advanced: false, completed: false, exited: false };
  mocks.processResult = { claimed: false, outcome: "skipped" };
});

const fns = () => calls.map((c) => c.fn);

describe("runJob routing", () => {
  it.each([
    [QUEUE.COMPILE, { flow_id: "f", tenant_id: "t" }, ["compile"]],
    [QUEUE.KB_EMBED, { kb_entry_id: "k", tenant_id: "t" }, ["kbEmbed"]],
    [QUEUE.REAP, {}, ["reap"]],
    [QUEUE.COUNTER_ROLLOVER, {}, ["counterRollover"]],
    [QUEUE.PARTITION_MAINTENANCE, {}, ["partitionMaintenance"]],
    [QUEUE.CONTENT_GENERATION, {}, ["contentTick"]],
    [QUEUE.GRID_SNAPSHOT, {}, ["gridSnapshot"]],
    [QUEUE.DRAIN, {}, ["drainTick"]],
    [QUEUE.DRAIN_MESSAGE, { tenant_id: "t", message_id: "m" }, ["drainMessage"]],
  ])("%s runs its handler", async (queue, data, expected) => {
    await runJob(queue, data, deps);
    expect(fns()).toEqual(expected);
    expect(enqueued).toEqual([]);
  });

  it("scan runs its phases in order (enrollment only after transitions)", async () => {
    await runJob(QUEUE.SCAN, {}, deps);
    expect(fns()).toEqual(["timeTransitions", "segmentEnrollment", "stepAdvancement", "engagementDepth"]);
  });

  it("job handlers receive the payload and the database handle", async () => {
    const data = { flow_id: "f1", tenant_id: "t1" };
    await runJob(QUEUE.COMPILE, data, deps);
    expect(calls[0]!.args).toEqual([data, db]);
  });

  it("every QUEUE name is handled", async () => {
    for (const queue of Object.values(QUEUE)) {
      await expect(runJob(queue, { tenant_id: "t", message_id: "m", membership_id: "x" }, deps)).resolves.toBeUndefined();
    }
  });

  it("an unknown job name throws", async () => {
    await expect(runJob("claros.nope", {}, deps)).rejects.toThrow("unknown job: claros.nope");
  });
});

describe("runJob chaining", () => {
  it("trigger-check enqueues advance-membership per enrolled membership", async () => {
    mocks.triggerCheckResult = { enrolledMembershipIds: ["m1", "m2"] };
    await runJob(QUEUE.TRIGGER_CHECK, { tenant_id: "t", contact_id: "c", event_name: "e" }, deps);
    expect(enqueued).toEqual([
      { queue: QUEUE.ADVANCE_MEMBERSHIP, data: { tenant_id: "t", membership_id: "m1" }, opts: { retryLimit: 2, retryDelay: 10, expireInSeconds: 300 } },
      { queue: QUEUE.ADVANCE_MEMBERSHIP, data: { tenant_id: "t", membership_id: "m2" }, opts: { retryLimit: 2, retryDelay: 10, expireInSeconds: 300 } },
    ]);
  });

  it("advance-membership enqueues process-message for a created message", async () => {
    mocks.advanceResult = { messageCreated: true, messageId: "msg1", advanced: true, completed: false, exited: false };
    await runJob(QUEUE.ADVANCE_MEMBERSHIP, { tenant_id: "t", membership_id: "m1" }, deps);
    expect(enqueued).toEqual([
      {
        queue: QUEUE.PROCESS_MESSAGE,
        data: { tenant_id: "t", message_id: "msg1" },
        opts: { singletonKey: "msg1", retryLimit: 2, retryDelay: 10, expireInSeconds: 300 },
      },
    ]);
  });

  it("advance-membership without a new message enqueues nothing", async () => {
    mocks.advanceResult = { messageCreated: false, messageId: null, advanced: true, completed: false, exited: false };
    await runJob(QUEUE.ADVANCE_MEMBERSHIP, { tenant_id: "t", membership_id: "m1" }, deps);
    expect(enqueued).toEqual([]);
  });

  it("process-message enqueues drain-message when the message is approved", async () => {
    mocks.processResult = { claimed: true, outcome: "advanced" };
    await runJob(QUEUE.PROCESS_MESSAGE, { tenant_id: "t", message_id: "msg1" }, deps);
    expect(enqueued).toEqual([
      {
        queue: QUEUE.DRAIN_MESSAGE,
        data: { tenant_id: "t", message_id: "msg1" },
        opts: { singletonKey: "msg1", retryLimit: 2, retryDelay: 10, expireInSeconds: 300 },
      },
    ]);
  });

  it("process-message that did not advance enqueues nothing", async () => {
    mocks.processResult = { claimed: true, outcome: "pending_approval" };
    await runJob(QUEUE.PROCESS_MESSAGE, { tenant_id: "t", message_id: "msg1" }, deps);
    expect(enqueued).toEqual([]);
  });
});

describe("runJob transport seam", () => {
  it("drain-message uses deps.resolveTransport when given", async () => {
    const resolver = vi.fn(async () => null);
    await runJob(QUEUE.DRAIN_MESSAGE, { tenant_id: "t", message_id: "m" }, { ...deps, resolveTransport: resolver });
    expect(calls[0]!.args[2]).toBe(resolver);
  });

  it("drain-message builds the tenant resolver from the database otherwise", async () => {
    await runJob(QUEUE.DRAIN_MESSAGE, { tenant_id: "t", message_id: "m" }, deps);
    expect(calls[0]!.args[2]).toBe("tenant-resolver");
  });

  it("drain passes the resolver to the drain tick", async () => {
    const resolver = vi.fn(async () => null);
    await runJob(QUEUE.DRAIN, {}, { ...deps, resolveTransport: resolver });
    expect(calls[0]!.args[2]).toBe(resolver);
  });
});

describe("runJob failures", () => {
  it("a failing handler rejects, so the runtime retries the job", async () => {
    const { handleCompileJob } = await import("../src/compile.js");
    vi.mocked(handleCompileJob).mockRejectedValueOnce(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runJob(QUEUE.COMPILE, { flow_id: "f", tenant_id: "t" }, deps)).rejects.toThrow("boom");
    spy.mockRestore();
  });
});
