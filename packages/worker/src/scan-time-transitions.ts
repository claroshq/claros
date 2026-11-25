/**
 * Scan phase 1: time-based lifecycle transitions.
 *
 * Iterates all tenants, then paginates contacts in states that have time-driven
 * transitions (engaged, at_risk, dormant, resurrected, activated). For each
 * contact, calls evaluateTimeTransition from @claros/core. If a transition is
 * indicated, applies it via CAS on contacts.lifecycle_state and writes an audit
 * row to lifecycle_transitions.
 *
 * Keyset pagination: ordered by (id) within a tenant, batches of BATCH_SIZE.
 * No persistent checkpoint - restart-from-top is safe because CAS prevents
 * double-fire, and the arithmetic shows the scan completes well within the
 * 15-minute interval at realistic scale (see BACKLOG.md for the threshold).
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor } from "@claros/store";
import {
  evaluateTimeTransition,
  resolveLifecycleConfig,
  type LifecycleConfig,
  type LifecycleState,
} from "@claros/core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of contacts fetched per keyset page. */
const BATCH_SIZE = 500;

/**
 * States that have time-driven transitions. Only contacts in these states
 * need to be evaluated by the scan.
 */
const TIME_TRANSITION_STATES: LifecycleState[] = [
  "engaged",
  "at_risk",
  "dormant",
  "resurrected",
  "activated",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

export interface PhaseTimeTransitionsResult {
  tenantsProcessed: number;
  contactsEvaluated: number;
  transitionsApplied: number;
  /** Transitions applied, for use by phase 2 (enrollment). */
  appliedTransitions: Array<{
    tenantId: string;
    contactId: string;
    fromState: string;
    toState: string;
  }>;
}

// ---------------------------------------------------------------------------
// Phase entry point
// ---------------------------------------------------------------------------

/**
 * Phase 1 of the scan: evaluate time-driven lifecycle transitions for all
 * tenants. Returns aggregate stats for observability.
 *
 * @param db - Drizzle database instance.
 * @param now - Current time (injected for testability).
 * @param tenantIds - Optional tenant scope. When provided, only these tenants
 *   are processed. When omitted, all tenants are processed (production default).
 */
export async function phaseTimeTransitions(
  db: Db,
  now: Date,
  tenantIds?: string[],
): Promise<PhaseTimeTransitionsResult> {
  const stats: PhaseTimeTransitionsResult = {
    tenantsProcessed: 0,
    contactsEvaluated: 0,
    transitionsApplied: 0,
    appliedTransitions: [],
  };

  // Load tenants: use provided list or discover all.
  const tenantRows: { id: string; settings: unknown }[] =
    await storeFor(db).workerScanTimeTransitions.listTenants(tenantIds);

  for (const tenant of tenantRows) {
    const settings = tenant.settings as Record<string, unknown> | null | undefined;
    const lifecycleOverrides = settings?.lifecycle as Partial<LifecycleConfig> | null | undefined;
    const config = resolveLifecycleConfig(lifecycleOverrides);

    const tenantStats = await processTenanTimeTransitions(
      db,
      tenant.id,
      config,
      now,
    );

    stats.contactsEvaluated += tenantStats.contactsEvaluated;
    stats.transitionsApplied += tenantStats.transitionsApplied;
    for (const t of tenantStats.appliedTransitions) {
      stats.appliedTransitions.push({ tenantId: tenant.id, ...t });
    }
    stats.tenantsProcessed++;
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Per-tenant processing
// ---------------------------------------------------------------------------

interface TenantPhaseResult {
  contactsEvaluated: number;
  transitionsApplied: number;
  appliedTransitions: Array<{
    contactId: string;
    fromState: string;
    toState: string;
  }>;
}

async function processTenanTimeTransitions(
  db: Db,
  tenantId: string,
  config: LifecycleConfig,
  now: Date,
): Promise<TenantPhaseResult> {
  let contactsEvaluated = 0;
  let transitionsApplied = 0;
  const appliedTransitions: Array<{ contactId: string; fromState: string; toState: string }> = [];
  let lastId: string | null = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Keyset pagination: fetch next batch of contacts in time-transition states.
    // On the first page, omit the id > $lastId condition.
    const batch = await storeFor(db).workerScanTimeTransitions.listContactsInStatesPage({
      tenantId,
      states: TIME_TRANSITION_STATES,
      afterId: lastId,
      limit: BATCH_SIZE,
    });

    if (batch.length === 0) break;

    for (const contact of batch) {
      contactsEvaluated++;

      // Skip contacts with no lastSeenAt (should not happen in practice,
      // but defensive - cannot evaluate time since last activity).
      if (!contact.lastSeenAt) continue;

      const transition = evaluateTimeTransition({
        currentState: contact.lifecycleState as LifecycleState,
        lastSeenAt: contact.lastSeenAt,
        now,
        config,
      });

      if (transition === null) continue;

      // Apply via CAS: only succeeds if lifecycle_state still matches.
      // On success the audit row is written too.
      const applied = await storeFor(db).workerScanTimeTransitions.applyTimeTransition({
        tenantId,
        contactId: contact.id,
        fromState: transition.from,
        toState: transition.to,
        now,
      });

      if (!applied) {
        // CAS failed: state was already changed by a concurrent process. No-op.
        continue;
      }

      appliedTransitions.push({
        contactId: contact.id,
        fromState: transition.from,
        toState: transition.to,
      });
      transitionsApplied++;
    }

    // Advance keyset cursor.
    lastId = batch[batch.length - 1]!.id;

    // If the batch was smaller than BATCH_SIZE, we've exhausted this tenant.
    if (batch.length < BATCH_SIZE) break;
  }

  return { contactsEvaluated, transitionsApplied, appliedTransitions };
}
