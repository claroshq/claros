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
const alerts = vi.hoisted(() => ({
  recordJobFailure: vi.fn(async () => undefined),
  recordTickRun: vi.fn(async () => undefined),
  recordDrainFaults: vi.fn(async () => undefined),
  checkSendErrors: vi.fn(async () => undefined),
  recordLlmCalls: vi.fn(async () => undefined),
  runAlertTick: vi.fn(async () => ({ lateTicks: [], resolved: 0, mailed: 0, storm: false })),
  runDigest: vi.fn(async () => ({ sent: false, deletedEvents: 0 })),
}));
vi.mock("../src/alerts.js", () => alerts);
vi.mock("@claros/store", () => ({
  storeFor: () => ({ workerIndex: { getAnyTenantSettings: async () => null } }),
}));

import { runJob, type JobDeps } from "../src/handlers.js";

const db = { tag: "db" } as never;
let enqueued: Array<{ queue: string; data: unknown; opts: unknown }>;
let deps: JobDeps;

beforeEach(() => {
  calls.length = 0;
  for (const fn of Object.values(alerts)) fn.mockClear();
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

describe("runJob alerts", () => {
  it("a failing job is recorded as an ops event once, then rethrown", async () => {
    const { handleCompileJob } = await import("../src/compile.js");
    const boom = new Error("boom");
    vi.mocked(handleCompileJob).mockRejectedValueOnce(boom);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runJob(QUEUE.COMPILE, { flow_id: "f", tenant_id: "t" }, deps)).rejects.toThrow("boom");
    spy.mockRestore();
    expect(alerts.recordJobFailure).toHaveBeenCalledTimes(1);
    expect(alerts.recordJobFailure).toHaveBeenCalledWith(db, QUEUE.COMPILE, { flow_id: "f", tenant_id: "t" }, boom);
    expect(alerts.recordTickRun).not.toHaveBeenCalled();
  });

  it("periodic jobs record their heartbeat; other jobs do not", async () => {
    await runJob(QUEUE.REAP, {}, deps);
    expect(alerts.recordTickRun).toHaveBeenCalledWith(db, QUEUE.REAP);
    alerts.recordTickRun.mockClear();
    await runJob(QUEUE.COMPILE, { flow_id: "f", tenant_id: "t" }, deps);
    expect(alerts.recordTickRun).not.toHaveBeenCalled();
  });

  it("the content tick runs the alert tick, also when the content work fails", async () => {
    await runJob(QUEUE.CONTENT_GENERATION, {}, deps);
    expect(alerts.runAlertTick).toHaveBeenCalledTimes(1);

    const { processContentTick } = await import("../src/content.js");
    const boom = new Error("content down");
    vi.mocked(processContentTick).mockRejectedValueOnce(boom);
    await expect(runJob(QUEUE.CONTENT_GENERATION, {}, deps)).rejects.toThrow("content down");
    expect(alerts.runAlertTick).toHaveBeenCalledTimes(2);
    // Recorded before the alert tick, and only once.
    expect(alerts.recordJobFailure).toHaveBeenCalledTimes(1);
    expect(alerts.recordJobFailure.mock.invocationCallOrder[0]).toBeLessThan(alerts.runAlertTick.mock.invocationCallOrder[1]!);
  });

  it("the content tick records LLM calls per product", async () => {
    const { processContentTick } = await import("../src/content.js");
    vi.mocked(processContentTick).mockResolvedValueOnce({
      claimed: 1, advanced: 0, skipped: 0, valueGated: 0, failed: 0, errors: 1,
      llmCalls: { t1: { calls: 2, errors: 1 } },
    } as never);
    await runJob(QUEUE.CONTENT_GENERATION, {}, deps);
    expect(alerts.recordLlmCalls).toHaveBeenCalledWith(db, "t1", { calls: 2, errors: 1 }, expect.any(Date));
  });

  it("process-message records its LLM calls", async () => {
    mocks.processResult = { claimed: true, outcome: "error", llm: { calls: 1, errors: 1 } } as never;
    await runJob(QUEUE.PROCESS_MESSAGE, { tenant_id: "t", message_id: "m" }, deps);
    expect(alerts.recordLlmCalls).toHaveBeenCalledWith(db, "t", { calls: 1, errors: 1 });
  });

  it("the drain records configuration faults and checks send errors", async () => {
    const { processDrainTick } = await import("../src/drain.js");
    const faults = [{ tenantId: "t", fault: "no_transport" }];
    vi.mocked(processDrainTick).mockResolvedValueOnce({ candidatesFetched: 0, configFaults: faults } as never);
    await runJob(QUEUE.DRAIN, {}, deps);
    expect(alerts.recordDrainFaults).toHaveBeenCalledWith(db, faults, expect.any(Date));
    expect(alerts.checkSendErrors).toHaveBeenCalledWith(db, expect.any(Date));
  });

  it("the alerts digest job runs the digest", async () => {
    const resolver = vi.fn(async () => null);
    await runJob(QUEUE.ALERTS_DIGEST, {}, { ...deps, resolveTransport: resolver });
    expect(alerts.runDigest).toHaveBeenCalledWith(db, { resolveTransport: resolver });
  });
});
