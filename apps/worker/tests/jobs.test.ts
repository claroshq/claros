/**
 * Unit tests for the Queues side of the Worker: the enqueue function and the
 * JOBS / dead letter consumers. runJob itself is tested in packages/worker.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const runJob = vi.fn();
vi.mock("@claros/worker/handlers", () => ({ runJob: (...args: unknown[]) => runJob(...args) }));

import { consumeDeadJobs, consumeJobs, queueEnqueue, retryDelaySeconds } from "../src/jobs.js";
import type { JobMessage, Message, MessageBatch } from "../src/bindings.js";

function message(body: JobMessage, attempts = 1) {
  return {
    id: "id",
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  } satisfies Message<JobMessage>;
}

const batch = (queue: string, messages: Message<JobMessage>[]): MessageBatch<JobMessage> => ({ queue, messages });
const deps = { db: {} as never, enqueue: vi.fn() };

beforeEach(() => {
  runJob.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("queueEnqueue", () => {
  it("sends { name, data, retryDelay } to the queue", async () => {
    const send = vi.fn(async () => {});
    const enqueue = queueEnqueue({ send, sendBatch: vi.fn() });
    const id = await enqueue("claros.trigger-check", { tenant_id: "t" }, { retryLimit: 2, retryDelay: 10, expireInMinutes: 5 });
    expect(id).toBeNull();
    expect(send).toHaveBeenCalledWith({ name: "claros.trigger-check", data: { tenant_id: "t" }, retryDelay: 10 }, undefined);
  });

  it("maps startAfter (seconds) to a delivery delay, capped at 12 hours", async () => {
    const send = vi.fn(async () => {});
    const enqueue = queueEnqueue({ send, sendBatch: vi.fn() });
    await enqueue("q", {}, { startAfter: 30 });
    await enqueue("q", {}, { startAfter: 100_000 });
    expect(send).toHaveBeenNthCalledWith(1, { name: "q", data: {} }, { delaySeconds: 30 });
    expect(send).toHaveBeenNthCalledWith(2, { name: "q", data: {} }, { delaySeconds: 43_200 });
  });

  it("sends without options when none are given", async () => {
    const send = vi.fn(async () => {});
    await queueEnqueue({ send, sendBatch: vi.fn() })("q", { a: 1 });
    expect(send).toHaveBeenCalledWith({ name: "q", data: { a: 1 } }, undefined);
  });
});

describe("retryDelaySeconds", () => {
  it("doubles from the base per attempt, capped at 15 minutes", () => {
    expect(retryDelaySeconds(1, 10)).toBe(10);
    expect(retryDelaySeconds(2, 10)).toBe(20);
    expect(retryDelaySeconds(3, 10)).toBe(40);
    expect(retryDelaySeconds(20, 10)).toBe(900);
  });

  it("uses 10 seconds when the sender set no base", () => {
    expect(retryDelaySeconds(1)).toBe(10);
  });
});

describe("consumeJobs", () => {
  it("runs each message and acks it on success", async () => {
    runJob.mockResolvedValue(undefined);
    const a = message({ name: "claros.scan", data: {} });
    const b = message({ name: "claros.drain-message", data: { message_id: "m" } });
    await consumeJobs(batch("claros-jobs", [a, b]), deps);
    expect(runJob).toHaveBeenNthCalledWith(1, "claros.scan", {}, deps);
    expect(runJob).toHaveBeenNthCalledWith(2, "claros.drain-message", { message_id: "m" }, deps);
    expect(a.ack).toHaveBeenCalled();
    expect(b.ack).toHaveBeenCalled();
  });

  it("retries a failed message with backoff and keeps going", async () => {
    runJob.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);
    const failing = message({ name: "claros.compile", data: {}, retryDelay: 10 }, 2);
    const ok = message({ name: "claros.scan", data: {} });
    await consumeJobs(batch("claros-jobs", [failing, ok]), deps);
    expect(failing.ack).not.toHaveBeenCalled();
    expect(failing.retry).toHaveBeenCalledWith({ delaySeconds: 20 });
    expect(ok.ack).toHaveBeenCalled();
  });
});

describe("consumeDeadJobs", () => {
  it("logs and acks dead jobs without running them", () => {
    const dead = message({ name: "claros.compile", data: { flow_id: "f" } }, 4);
    consumeDeadJobs(batch("claros-jobs-dlq", [dead]));
    expect(runJob).not.toHaveBeenCalled();
    expect(dead.ack).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("dead job claros.compile"), '{"flow_id":"f"}');
  });
});
