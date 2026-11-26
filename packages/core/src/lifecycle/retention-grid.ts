/**
 * Retention grid - pure logic (no I/O).
 *
 * A strategic read model on top of the lifecycle state machine: tenure
 * (how long a contact has been around, from first_seen_at) crossed with
 * recency (how long since their last activity, from last_seen_at). The
 * grid answers "who should we act on now" - the 7-state chain remains the
 * engine's trigger model; the grid is the operator's map.
 *
 * Tenure thresholds are calendar-fixed. Recency thresholds derive from the
 * tenant's natural_frequency_days so the grid adapts to the product's
 * rhythm instead of hardcoding 7/14/30 days.
 *
 * The same bucket functions drive both the analytics endpoint (read model)
 * and segment-trigger enrollment (engine), so a cell on the screen and the
 * audience of a segment flow are provably the same set.
 */

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

export const RETENTION_TENURE_BUCKETS = [
  "new",
  "growing",
  "established",
  "loyal",
] as const;

export type RetentionTenureBucket = (typeof RETENTION_TENURE_BUCKETS)[number];

export const RETENTION_RECENCY_BUCKETS = [
  "active",
  "cooling",
  "idle",
  "dormant",
] as const;

export type RetentionRecencyBucket = (typeof RETENTION_RECENCY_BUCKETS)[number];

/** Tenure boundaries in days: new [0,30), growing [30,90), established [90,180), loyal [180,inf). */
export const RETENTION_TENURE_THRESHOLDS_DAYS = {
  growing: 30,
  established: 90,
  loyal: 180,
} as const;

/** Recency boundaries as multiples of natural_frequency_days: active <1x, cooling [1x,2x), idle [2x,4x), dormant 4x+. */
export const RETENTION_RECENCY_MULTIPLIERS = {
  cooling: 1,
  idle: 2,
  dormant: 4,
} as const;

// ---------------------------------------------------------------------------
// Audience (paid / free split)
// ---------------------------------------------------------------------------

/**
 * payment_status values that count as paying. The grid's `paying` column,
 * its daily snapshots and the Lifecycle page's audience filter all use
 * this set, so "paid" means the same contacts everywhere.
 */
export const PAYING_PAYMENT_STATUSES = ["paid", "past_due"] as const;

/**
 * Who an analytics read covers, by the contact's CURRENT payment_status:
 * all contacts, paying ones (PAYING_PAYMENT_STATUSES) or everyone else
 * (free, trial, cancelled, unset). paid + free = all.
 */
export const CONTACT_AUDIENCES = ["all", "paid", "free"] as const;

export type ContactAudience = (typeof CONTACT_AUDIENCES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Bucket assignment
// ---------------------------------------------------------------------------

/** Assign a contact to a tenure bucket from its first_seen_at. */
export function tenureBucket(firstSeenAt: Date, now: Date): RetentionTenureBucket {
  const ageDays = (now.getTime() - firstSeenAt.getTime()) / DAY_MS;
  if (ageDays >= RETENTION_TENURE_THRESHOLDS_DAYS.loyal) return "loyal";
  if (ageDays >= RETENTION_TENURE_THRESHOLDS_DAYS.established) return "established";
  if (ageDays >= RETENTION_TENURE_THRESHOLDS_DAYS.growing) return "growing";
  return "new";
}

/** Assign a contact to a recency bucket from its last_seen_at and the tenant rhythm. */
export function recencyBucket(
  lastSeenAt: Date,
  now: Date,
  naturalFrequencyDays: number,
): RetentionRecencyBucket {
  const ageDays = (now.getTime() - lastSeenAt.getTime()) / DAY_MS;
  const f = naturalFrequencyDays;
  if (ageDays >= RETENTION_RECENCY_MULTIPLIERS.dormant * f) return "dormant";
  if (ageDays >= RETENTION_RECENCY_MULTIPLIERS.idle * f) return "idle";
  if (ageDays >= RETENTION_RECENCY_MULTIPLIERS.cooling * f) return "cooling";
  return "active";
}

/** Human-readable day thresholds for the UI ("dormant = 28+ days quiet"). */
export function recencyThresholdDays(naturalFrequencyDays: number): {
  cooling: number;
  idle: number;
  dormant: number;
} {
  return {
    cooling: RETENTION_RECENCY_MULTIPLIERS.cooling * naturalFrequencyDays,
    idle: RETENTION_RECENCY_MULTIPLIERS.idle * naturalFrequencyDays,
    dormant: RETENTION_RECENCY_MULTIPLIERS.dormant * naturalFrequencyDays,
  };
}

/** Day range [minDays, maxDays) covered by a tenure bucket. maxDays null = unbounded. */
export function tenureBucketRange(bucket: RetentionTenureBucket): {
  minDays: number;
  maxDays: number | null;
} {
  switch (bucket) {
    case "new":
      return { minDays: 0, maxDays: RETENTION_TENURE_THRESHOLDS_DAYS.growing };
    case "growing":
      return {
        minDays: RETENTION_TENURE_THRESHOLDS_DAYS.growing,
        maxDays: RETENTION_TENURE_THRESHOLDS_DAYS.established,
      };
    case "established":
      return {
        minDays: RETENTION_TENURE_THRESHOLDS_DAYS.established,
        maxDays: RETENTION_TENURE_THRESHOLDS_DAYS.loyal,
      };
    case "loyal":
      return { minDays: RETENTION_TENURE_THRESHOLDS_DAYS.loyal, maxDays: null };
  }
}

/** Day range [minDays, maxDays) covered by a recency bucket. maxDays null = unbounded. */
export function recencyBucketRange(
  bucket: RetentionRecencyBucket,
  naturalFrequencyDays: number,
): { minDays: number; maxDays: number | null } {
  const f = naturalFrequencyDays;
  switch (bucket) {
    case "active":
      return { minDays: 0, maxDays: RETENTION_RECENCY_MULTIPLIERS.cooling * f };
    case "cooling":
      return {
        minDays: RETENTION_RECENCY_MULTIPLIERS.cooling * f,
        maxDays: RETENTION_RECENCY_MULTIPLIERS.idle * f,
      };
    case "idle":
      return {
        minDays: RETENTION_RECENCY_MULTIPLIERS.idle * f,
        maxDays: RETENTION_RECENCY_MULTIPLIERS.dormant * f,
      };
    case "dormant":
      return { minDays: RETENTION_RECENCY_MULTIPLIERS.dormant * f, maxDays: null };
  }
}

// ---------------------------------------------------------------------------
// Segment trigger config
// ---------------------------------------------------------------------------

/**
 * Shape of trigger_config for segment triggers: one retention-grid cell.
 * Stored as JSONB in flows.trigger_config.
 */
export interface SegmentTriggerConfig {
  tenure_bucket: RetentionTenureBucket;
  recency_bucket: RetentionRecencyBucket;
}

/** Runtime validation for a segment trigger_config value. */
export function isSegmentTriggerConfig(value: unknown): value is SegmentTriggerConfig {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.tenure_bucket === "string" &&
    (RETENTION_TENURE_BUCKETS as readonly string[]).includes(v.tenure_bucket) &&
    typeof v.recency_bucket === "string" &&
    (RETENTION_RECENCY_BUCKETS as readonly string[]).includes(v.recency_bucket)
  );
}

/**
 * P5b: a segment trigger by lifecycle state (and engagement depth) instead of
 * a grid cell: contacts whose lifecycle_state is one of `lifecycle_states`
 * (any state when absent) and whose engagement_depth is one of
 * `engagement_depths` (any depth when absent). At least one list is set.
 */
export interface LifecycleSegmentTriggerConfig {
  lifecycle_states?: string[];
  engagement_depths?: string[];
}

export function isLifecycleSegmentTriggerConfig(value: unknown): value is LifecycleSegmentTriggerConfig {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const list = (x: unknown) => x === undefined || (Array.isArray(x) && x.length > 0 && x.every((s) => typeof s === "string"));
  if (!list(v.lifecycle_states) || !list(v.engagement_depths)) return false;
  return v.lifecycle_states !== undefined || v.engagement_depths !== undefined;
}

/**
 * Check whether a segment-trigger flow targets the given grid cell.
 * Returns false for non-segment flows or malformed config.
 */
export function matchesSegmentTrigger(
  flow: { triggerType: string; triggerConfig: unknown },
  tenure: RetentionTenureBucket,
  recency: RetentionRecencyBucket,
): boolean {
  if (flow.triggerType !== "segment") return false;
  if (!isSegmentTriggerConfig(flow.triggerConfig)) return false;
  return (
    flow.triggerConfig.tenure_bucket === tenure &&
    flow.triggerConfig.recency_bucket === recency
  );
}
