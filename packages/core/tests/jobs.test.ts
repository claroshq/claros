/**
 * Tests for @claros/core queue contract.
 *
 * Covers the queue names and payload types defined in tasks 5, 11, 12b, 14, 15, and 22.
 * Additional queues added in Phase 2 get their own tests in the same commit.
 */
import { describe, it, expect } from "vitest";
import { QUEUE, CLAROS_CORE_VERSION } from "../src/index.js";
import type { ScanJobData, CompileJobData, TriggerCheckJobData, DrainJobData, ReapJobData, CounterRolloverJobData, PartitionMaintenanceJobData, ContentGenerationJobData, KbEmbedJobData, QueueName } from "../src/index.js";

describe("@claros/core - version", () => {
  it("exports version", () => {
    expect(CLAROS_CORE_VERSION).toBe("0.0.0");
  });
});

describe("QUEUE constants", () => {
  it("SCAN is claros.scan", () => {
    expect(QUEUE.SCAN).toBe("claros.scan");
  });

  it("COMPILE is claros.compile", () => {
    expect(QUEUE.COMPILE).toBe("claros.compile");
  });

  it("TRIGGER_CHECK is claros.trigger-check", () => {
    expect(QUEUE.TRIGGER_CHECK).toBe("claros.trigger-check");
  });

  it("DRAIN is claros.drain", () => {
    expect(QUEUE.DRAIN).toBe("claros.drain");
  });

  it("REAP is claros.reap", () => {
    expect(QUEUE.REAP).toBe("claros.reap");
  });

  it("COUNTER_ROLLOVER is claros.counter-rollover", () => {
    expect(QUEUE.COUNTER_ROLLOVER).toBe("claros.counter-rollover");
  });

  it("PARTITION_MAINTENANCE is claros.partition-maintenance", () => {
    expect(QUEUE.PARTITION_MAINTENANCE).toBe("claros.partition-maintenance");
  });

  it("CONTENT_GENERATION is claros.content-generation", () => {
    expect(QUEUE.CONTENT_GENERATION).toBe("claros.content-generation");
  });

  it("KB_EMBED is claros.kb-embed", () => {
    expect(QUEUE.KB_EMBED).toBe("claros.kb-embed");
  });

  it("all queue names use the claros. prefix", () => {
    for (const [key, value] of Object.entries(QUEUE)) {
      expect(value, `QUEUE.${key}`).toMatch(/^claros\./);
    }
  });

  it("all queue names are unique", () => {
    const values = Object.values(QUEUE);
    expect(new Set(values).size).toBe(values.length);
  });

  it("QUEUE has exactly 15 entries (SCAN + COMPILE + TRIGGER_CHECK + DRAIN + REAP + COUNTER_ROLLOVER + PARTITION_MAINTENANCE + CONTENT_GENERATION + KB_EMBED + ADVANCE_MEMBERSHIP + PROCESS_MESSAGE + DRAIN_MESSAGE + GRID_SNAPSHOT + ALERTS_DIGEST + WEBHOOK_DELIVERY)", () => {
    expect(Object.keys(QUEUE)).toHaveLength(15);
  });

  it("QueueName is assignable from QUEUE values", () => {
    const names: QueueName[] = Object.values(QUEUE);
    expect(names).toHaveLength(15);
  });
});

describe("ScanJobData payload type", () => {
  it("ScanJobData is an empty-object shape", () => {
    const data: ScanJobData = {};
    expect(data).toEqual({});
  });
});

describe("CompileJobData payload type", () => {
  it("CompileJobData has flow_id and tenant_id", () => {
    const data: CompileJobData = {
      flow_id: "00000000-0000-0000-0000-000000000001",
      tenant_id: "00000000-0000-0000-0000-000000000002",
    };
    expect(data.flow_id).toBeDefined();
    expect(data.tenant_id).toBeDefined();
  });
});

describe("TriggerCheckJobData payload type", () => {
  it("TriggerCheckJobData has tenant_id, contact_id, and event_name", () => {
    const data: TriggerCheckJobData = {
      tenant_id: "00000000-0000-0000-0000-000000000001",
      contact_id: "00000000-0000-0000-0000-000000000002",
      event_name: "plan_upgraded",
    };
    expect(data.tenant_id).toBeDefined();
    expect(data.contact_id).toBeDefined();
    expect(data.event_name).toBeDefined();
  });
});

describe("DrainJobData payload type", () => {
  it("DrainJobData is an empty-object shape", () => {
    const data: DrainJobData = {};
    expect(data).toEqual({});
  });
});

describe("ReapJobData payload type", () => {
  it("ReapJobData is an empty-object shape", () => {
    const data: ReapJobData = {};
    expect(data).toEqual({});
  });
});

describe("CounterRolloverJobData payload type", () => {
  it("CounterRolloverJobData is an empty-object shape", () => {
    const data: CounterRolloverJobData = {};
    expect(data).toEqual({});
  });
});

describe("PartitionMaintenanceJobData payload type", () => {
  it("PartitionMaintenanceJobData is an empty-object shape", () => {
    const data: PartitionMaintenanceJobData = {};
    expect(data).toEqual({});
  });
});

describe("ContentGenerationJobData payload type", () => {
  it("ContentGenerationJobData is an empty-object shape", () => {
    const data: ContentGenerationJobData = {};
    expect(data).toEqual({});
  });
});

describe("KbEmbedJobData payload type", () => {
  it("KbEmbedJobData has kb_entry_id and tenant_id", () => {
    const data: KbEmbedJobData = {
      kb_entry_id: "00000000-0000-0000-0000-000000000001",
      tenant_id: "00000000-0000-0000-0000-000000000002",
    };
    expect(data.kb_entry_id).toBeDefined();
    expect(data.tenant_id).toBeDefined();
  });
});
