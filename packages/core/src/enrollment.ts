/**
 * Flow enrollment - pure logic (no I/O).
 *
 * Contains trigger matching, re-entry policy evaluation, and priority
 * resolution. Used by the worker (scan phase 2 and trigger-check job).
 */

import { createHash } from "node:crypto";
import type { FlowTriggerType, ReentryPolicy, FlowClass } from "./flow/index.js";

// ---------------------------------------------------------------------------
// Trigger matching
// ---------------------------------------------------------------------------

/**
 * Shape of trigger_config for lifecycle_transition triggers.
 * Stored as JSONB in flows.trigger_config.
 */
export interface LifecycleTransitionTriggerConfig {
  from: string;
  to: string;
}

/**
 * Shape of trigger_config for event triggers.
 * Stored as JSONB in flows.trigger_config.
 */
export interface EventTriggerConfig {
  event: string;
}

/**
 * A flow row with the subset of columns needed for enrollment evaluation.
 */
export interface EnrollableFlow {
  id: string;
  tenantId: string;
  priority: number;
  triggerType: FlowTriggerType;
  triggerConfig: unknown;
  flowClass: FlowClass;
  reentryPolicy: ReentryPolicy;
  reentryCooldownDays: number;
}

/**
 * Check whether a lifecycle_transition flow's trigger_config matches a
 * specific transition (from -> to).
 *
 * Returns false for non-lifecycle_transition flows or malformed config.
 */
export function matchesLifecycleTransition(
  flow: EnrollableFlow,
  fromState: string,
  toState: string,
): boolean {
  if (flow.triggerType !== "lifecycle_transition") return false;
  const config = flow.triggerConfig as Record<string, unknown> | null;
  if (!config || typeof config !== "object") return false;
  return config.from === fromState && config.to === toState;
}

/**
 * Check whether an event-trigger flow's trigger_config matches an event name.
 *
 * Returns false for non-event flows or malformed config.
 */
export function matchesEventTrigger(
  flow: EnrollableFlow,
  eventName: string,
): boolean {
  if (flow.triggerType !== "event") return false;
  const config = flow.triggerConfig as Record<string, unknown> | null;
  if (!config || typeof config !== "object") return false;
  return config.event === eventName;
}

// ---------------------------------------------------------------------------
// Priority resolution
// ---------------------------------------------------------------------------

/**
 * Sort flows by priority descending, then by id ascending (deterministic
 * tie-break). Returns a new sorted array; does not mutate the input.
 */
export function sortByPriority<T extends { priority: number; id: string }>(
  flows: T[],
): T[] {
  return [...flows].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Re-entry evaluation
// ---------------------------------------------------------------------------

/**
 * A prior membership for the same (contact, flow) - needed to evaluate
 * re-entry policy. Only the most recent non-active membership matters.
 */
export interface PriorMembership {
  exitedAt: Date | null;
  completedAt: Date | null;
  exitReason: string | null;
}

/**
 * Evaluate whether re-entry is allowed for a flow given the re-entry policy
 * and the most recent prior membership (if any).
 *
 * Returns true if enrollment is permitted, false if blocked by policy.
 *
 * Rules:
 *   - once: blocked if any prior membership exists
 *   - cooldown: blocked if prior membership ended within cooldown_days,
 *     UNLESS the prior exit was priority_override (forced eviction does not
 *     consume cooldown)
 *   - every_time: always allowed
 */
export function isReentryAllowed(
  policy: ReentryPolicy,
  cooldownDays: number,
  priorMembership: PriorMembership | null,
  now: Date,
): boolean {
  // No prior membership - always allowed (first enrollment)
  if (priorMembership === null) return true;

  switch (policy) {
    case "every_time":
      return true;

    case "once":
      // Any prior membership blocks re-entry, regardless of exit_reason
      return false;

    case "cooldown": {
      // priority_override does not consume cooldown - the contact was
      // forcibly removed, not finished
      if (priorMembership.exitReason === "priority_override") return true;

      // Determine when the prior membership ended
      const endedAt = priorMembership.exitedAt ?? priorMembership.completedAt;
      if (endedAt === null) {
        // No end timestamp - treat as recent (block). This should not
        // happen in practice (non-active memberships have an end date).
        return false;
      }

      const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;
      const elapsed = now.getTime() - endedAt.getTime();
      return elapsed >= cooldownMs;
    }
  }
}

// ---------------------------------------------------------------------------
// Advisory lock key
// ---------------------------------------------------------------------------

/**
 * Namespace for enrollment advisory locks. XORed with the contact UUID prefix
 * to avoid collisions with other advisory lock usage in the system (e.g.,
 * PgGate tests use low-range lock IDs).
 *
 * Value chosen to stay within signed 64-bit range after XOR with any UUID
 * prefix. Using a smaller namespace (4 bytes) XORed into the upper half.
 */
const ENROLLMENT_LOCK_NAMESPACE = BigInt("0x636C6172");

/**
 * Convert a contact UUID to a bigint suitable for pg_advisory_xact_lock.
 *
 * Takes the first 15 hex chars of the UUID (just under 8 bytes), parses as
 * BigInt, XORs with a fixed namespace. The result is guaranteed to fit within
 * a signed 64-bit integer (max 2^63 - 1 = 9223372036854775807) because 15
 * hex digits max = 0xFFFFFFFFFFFFFFF = 1152921504606846975 which is well
 * under 2^63.
 *
 * Collisions (two UUIDs mapping to the same key) are astronomically
 * unlikely with UUIDv4 and harmless if they occur - they only cause
 * unnecessary serialization of unrelated contacts' enrollment decisions.
 */
export function contactEnrollmentLockKey(contactId: string): bigint {
  const hex = contactId.replace(/-/g, "").slice(0, 15);
  const raw = BigInt("0x" + hex);
  // XOR with namespace. Result is at most 15 hex digits which fits in int8.
  return raw ^ ENROLLMENT_LOCK_NAMESPACE;
}

// ---------------------------------------------------------------------------
// Dedup advisory lock key
// ---------------------------------------------------------------------------

/**
 * Namespace for event dedup advisory locks. XORed with a hash of
 * (tenant_id, message_id) to produce a 64-bit lock key.
 *
 * Value: "dedu" in hex = 0x64656475. Distinct from ENROLLMENT_LOCK_NAMESPACE
 * (0x636C6172 = "clar"). Two distinct messageIds that hash to the same key
 * cause unnecessary serialization (one waits for the other's transaction),
 * never incorrect dedup - the SELECT inside the lock checks actual column
 * values, not the lock key.
 *
 * Namespace separation from enrollment locks: enrollment uses
 * 0x636C6172 XOR contactHex[0..15]; dedup uses 0x64656475 XOR
 * sha256("tenantId:messageId")[0..15]. A cross-namespace collision is
 * ~1 in 2^60 with random inputs, and even if it occurs the effect is
 * harmless serialization of unrelated operations (enrollment vs dedup),
 * never data corruption.
 */
const DEDUP_LOCK_NAMESPACE = BigInt("0x64656475");

/**
 * Compute an advisory lock key for event dedup.
 *
 * Derivation: SHA-256 of "tenantId:messageId", first 15 hex digits, XOR the
 * dedup namespace. Hashing (rather than slicing raw characters, as an earlier
 * version did) accepts arbitrary messageIds: the raw-slice version threw on
 * any non-hex character, turning a client-supplied messageId like "m-1" or
 * "order-55-retry" into a 500 on the ingest hot path. Lock keys are
 * transaction-scoped and never persisted, so the derivation can change
 * between deploys without consequence.
 *
 * Cost: one extra round trip per event that carries a messageId, none for
 * events without one.
 */
export function dedupLockKey(tenantId: string, messageId: string): bigint {
  const hash = createHash("sha256").update(`${tenantId}:${messageId}`).digest("hex");
  const combined = BigInt("0x" + hash.slice(0, 15)); // 15 hex digits fits in int8
  return combined ^ DEDUP_LOCK_NAMESPACE;
}
