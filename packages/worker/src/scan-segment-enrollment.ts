/**
 * Scan phase 2b: flow enrollment for segment triggers.
 *
 * Runs after phase 2 (lifecycle-transition enrollment). For each tenant,
 * loads active, compiled flows with trigger_type = 'segment'. Each such
 * flow targets one retention-grid cell (tenure_bucket x recency_bucket).
 * Contacts currently inside that cell are enrolled through the standard
 * enrollment sequence (suppression, class concurrency, re-entry policy,
 * race backstop), so segment flows obey exactly the same guards as every
 * other trigger type.
 *
 * Re-running is safe: contacts already actively enrolled are excluded in
 * SQL, and re-entry policy decides whether a contact who left the flow may
 * return when they re-enter the cell.
 *
 * Throughput is bounded per flow per scan (SEGMENT_ENROLLMENT_CAP): a
 * brand-new segment flow over a large cell enrolls over several scan runs
 * rather than in one burst, so a big tenant cannot starve the scan
 * interval. The cap is per-flow, not per-tenant: fairness across flows
 * within a tenant matches the scan's per-tenant fairness across tenants.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor } from "@claros/store";
import {
  resolveLifecycleConfig,
  isSegmentTriggerConfig,
  isLifecycleSegmentTriggerConfig,
  toFlowClass,
  tenureBucketRange,
  recencyBucketRange,
  type EnrollableFlow,
  type LifecycleConfig,
  type SegmentTriggerConfig,
  storedLifecycleState,
} from "@claros/core";
import { enrollContactInFlows } from "./enroll.js";
import { passesTriggerWhere } from "./audience.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of contacts fetched per keyset page within one flow's cell. */
const BATCH_SIZE = 200;

/**
 * Maximum enrollments per flow per scan run. Bounds the work a new segment
 * flow over a large cell can create in one 15-minute interval; the rest
 * enrolls on later runs.
 */
const SEGMENT_ENROLLMENT_CAP = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

export interface PhaseSegmentEnrollmentResult {
  tenantsProcessed: number;
  flowsEvaluated: number;
  enrollmentsAttempted: number;
  enrollmentsSucceeded: number;
  /** Flows whose cell still had matching contacts when the cap was hit. */
  flowsCapped: number;
}

// ---------------------------------------------------------------------------
// Phase entry point
// ---------------------------------------------------------------------------

/**
 * Phase 2b of the scan: enroll contacts into segment-triggered flows whose
 * retention-grid cell they currently occupy.
 *
 * @param db - Drizzle database instance.
 * @param now - Current time (injected for testability).
 * @param tenantIds - Optional tenant scope (production default: all).
 */
export async function phaseSegmentEnrollment(
  db: Db,
  now: Date,
  tenantIds?: string[],
): Promise<PhaseSegmentEnrollmentResult> {
  const stats: PhaseSegmentEnrollmentResult = {
    tenantsProcessed: 0,
    flowsEvaluated: 0,
    enrollmentsAttempted: 0,
    enrollmentsSucceeded: 0,
    flowsCapped: 0,
  };

  const tenantRows: { id: string; settings: unknown }[] =
    await storeFor(db).workerScanSegmentEnrollment.listTenants(tenantIds);

  for (const tenant of tenantRows) {
    const settings = tenant.settings as Record<string, unknown> | null | undefined;
    const config = resolveLifecycleConfig(
      settings?.lifecycle as Partial<LifecycleConfig> | null | undefined,
    );

    // Small cardinality: a tenant typically has < 50 flows total.
    const segmentFlows =
      await storeFor(db).workerScanSegmentEnrollment.listActiveSegmentFlows(tenant.id);

    for (const flow of segmentFlows) {
      const byCell = isSegmentTriggerConfig(flow.triggerConfig);
      const byState = !byCell && isLifecycleSegmentTriggerConfig(flow.triggerConfig);
      if (!byCell && !byState) continue;
      stats.flowsEvaluated++;

      const enrollable: EnrollableFlow = {
        id: flow.id,
        tenantId: flow.tenantId,
        priority: flow.priority ?? 0,
        triggerType: "segment",
        triggerConfig: flow.triggerConfig,
        flowClass: toFlowClass(flow.flowClass),
        reentryPolicy: (flow.reentryPolicy ?? "cooldown") as "once" | "cooldown" | "every_time",
        reentryCooldownDays: flow.reentryCooldownDays ?? 30,
      };

      const flowStats = await processSegmentFlow(db, tenant.id, enrollable, config, now);

      stats.enrollmentsAttempted += flowStats.attempted;
      stats.enrollmentsSucceeded += flowStats.succeeded;
      if (flowStats.capped) stats.flowsCapped++;
    }

    stats.tenantsProcessed++;
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Per-flow processing
// ---------------------------------------------------------------------------

interface SegmentFlowResult {
  attempted: number;
  succeeded: number;
  capped: boolean;
}

async function processSegmentFlow(
  db: Db,
  tenantId: string,
  flow: EnrollableFlow,
  config: LifecycleConfig,
  now: Date,
): Promise<SegmentFlowResult> {
  const store = storeFor(db).workerScanSegmentEnrollment;
  // A grid cell (tenure x recency) or, P5b, lifecycle states / engagement depths.
  const triggerConfig = flow.triggerConfig;
  const cell = isSegmentTriggerConfig(triggerConfig) ? (triggerConfig as SegmentTriggerConfig) : null;
  const byState = cell ? null : (triggerConfig as { lifecycle_states?: string[]; engagement_depths?: string[] });
  const tenure = cell ? tenureBucketRange(cell.tenure_bucket) : null;
  const recency = cell ? recencyBucketRange(cell.recency_bucket, config.natural_frequency_days) : null;

  const result: SegmentFlowResult = { attempted: 0, succeeded: 0, capped: false };
  let lastId: string | null = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (result.attempted >= SEGMENT_ENROLLMENT_CAP) {
      result.capped = true;
      break;
    }

    // Contacts whose tenure and recency ages fall inside the cell, excluding
    // anyone already actively enrolled in this flow. Keyset pagination by id.
    const limit = Math.min(BATCH_SIZE, SEGMENT_ENROLLMENT_CAP - result.attempted);
    const batch: { id: string }[] = cell
      ? await store.listCellContactsPage({ tenantId, flowId: flow.id, now, tenure: tenure!, recency: recency!, afterId: lastId, limit })
      : await store.listStateContactsPage({
          tenantId,
          flowId: flow.id,
          states: byState?.lifecycle_states?.map(storedLifecycleState) ?? null,
          depths: byState?.engagement_depths ?? null,
          afterId: lastId,
          limit,
        });

    if (batch.length === 0) break;

    for (const contact of batch) {
      result.attempted++;
      // P5b: the trigger's `where` must hold for the contact.
      if (!(await passesTriggerWhere(store, triggerConfig, tenantId, contact.id, now))) {
        if (result.attempted >= SEGMENT_ENROLLMENT_CAP) break;
        continue;
      }
      // enrollContactInFlows opens the transaction (advisory lock inside)
      const results = await enrollContactInFlows(
        db,
        contact.id,
        tenantId,
        [flow],
        now,
      );
      if (results.some((r) => r.enrolled)) {
        result.succeeded++;
      }
      if (result.attempted >= SEGMENT_ENROLLMENT_CAP) break;
    }

    lastId = batch[batch.length - 1]!.id;
    if (batch.length < BATCH_SIZE) break;
  }

  return result;
}
