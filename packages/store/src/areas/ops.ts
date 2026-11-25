/**
 * Queries for operational events and alerts (G25).
 *
 * Shared by the modules that record and read them: packages/worker/src/alerts.ts
 * (recording, alert mail, digest, checks), packages/api/src/routes/instance.ts
 * (Health) and packages/api/src/routes/webhooks/resend.ts (webhook failures).
 * Implementations: ../pg/ops.ts (Postgres) and ../d1/ops.ts (SQLite / D1).
 *
 * ops_events and ops_alerts are instance-level (instance admins only):
 * tenantId names the product an event is about and is not a scope. The
 * message and send queries below read every product by design.
 */

export interface OpsEventInput {
  at: Date;
  tenantId: string | null;
  kind: string;
  severity: string;
  fingerprint: string;
  message: string;
  context?: Record<string, unknown> | null;
}

export interface OpsEventRow {
  id: string;
  at: Date;
  tenantId: string | null;
  kind: string;
  severity: string;
  fingerprint: string;
  message: string;
  context: unknown;
}

export interface OpsAlertRow {
  fingerprint: string;
  kind: string;
  tenantId: string | null;
  severity: string;
  message: string;
  firstAt: Date;
  lastAt: Date;
  count: number;
  lastNotifiedAt: Date | null;
  notifiedCount: number;
  status: string;
  mutedUntil: Date | null;
}

/** Events of one fingerprint within a period. */
export interface OpsEventGroupRow {
  fingerprint: string;
  kind: string;
  tenantId: string | null;
  severity: string;
  /** The latest occurrence's message. */
  message: string;
  count: number;
  lastAt: Date;
}

export interface OpsSettingRow {
  key: string;
  value: unknown;
  updatedAt: Date | null;
}

/** Send attempts of one product on one transport within a window. */
export interface OpsSendOutcomeRow {
  tenantId: string;
  /** null for messages without a recorded transport (sent before transport ids were kept). */
  transportId: string | null;
  transportKind: string | null;
  transportName: string | null;
  sent: number;
  /** Status 'failed' after a send attempt (permanent provider errors, reaped retries). */
  failed: number;
  /** Still 'sending' after a send attempt (transient provider errors awaiting reap). */
  stuck: number;
}

export interface OpsSendFailureRow {
  tenantId: string;
  transportId: string | null;
  transportKind: string | null;
  reason: string;
}

export interface OpsProductRow {
  id: string;
  slug: string;
  name: string;
}

export interface OpsSendTotalsRow {
  tenantId: string;
  sent: number;
  failed: number;
}

export interface OpsApprovalsRow {
  tenantId: string;
  pending: number;
  oldestAt: Date | null;
}

export interface OpsQueries {
  /**
   * Record an event. With `alert`, also open (or bump) the fingerprint's
   * alert in the same atomic unit: count + 1, last_at, latest severity and
   * message. A resolved alert that occurs again reopens as new (count 1,
   * not notified).
   */
  recordEvent(event: OpsEventInput, opts: { alert: boolean }): Promise<void>;
  /** Bump an open alert's count and last_at without an event row; false when no open alert has the fingerprint. */
  touchAlert(args: { fingerprint: string; at: Date }): Promise<boolean>;
  /** Alerts by status ('open' | 'resolved'), or every alert when status is omitted; last_at newest first. */
  listAlerts(args: { status?: string; limit: number }): Promise<OpsAlertRow[]>;
  getAlert(fingerprint: string): Promise<OpsAlertRow | null>;
  /**
   * Claim the right to mail an alert (CAS on last_notified_at and the open
   * status): sets last_notified_at = at and notified_count = count. True when
   * this call won.
   */
  claimNotification(args: { fingerprint: string; expectedLastNotifiedAt: Date | null; at: Date }): Promise<boolean>;
  /** Resolve an open alert; returns it, or null when it is not open. */
  resolveAlert(args: { fingerprint: string }): Promise<OpsAlertRow | null>;
  /** Resolve every open alert whose last occurrence is before `before`; returns the resolved alerts. */
  resolveStaleAlerts(args: { before: Date }): Promise<OpsAlertRow[]>;
  /** Mute an alert until `until`; returns it, or null when it does not exist. */
  muteAlert(args: { fingerprint: string; until: Date }): Promise<OpsAlertRow | null>;
  /** Events since `since`, newest first. */
  listEvents(args: { since: Date; limit: number }): Promise<OpsEventRow[]>;
  /** Events since `since` grouped by fingerprint, most frequent first. */
  groupEventsSince(args: { since: Date }): Promise<OpsEventGroupRow[]>;
  /** Number of events of the given kinds since `since`. */
  countEventsSince(args: { kinds: string[]; since: Date }): Promise<number>;
  /** Delete events before `before`; returns the number deleted. */
  deleteEventsBefore(before: Date): Promise<number>;
  /** Delete resolved alerts whose last occurrence is before `before`; returns the number deleted. */
  deleteResolvedAlertsBefore(before: Date): Promise<number>;

  /** One instance setting, or null. */
  getSetting(key: string): Promise<OpsSettingRow | null>;
  /** Insert or replace an instance setting. */
  putSetting(args: { key: string; value: unknown; now: Date }): Promise<void>;
  /** Instance settings whose key starts with `prefix`, key order. */
  listSettingsByPrefix(prefix: string): Promise<OpsSettingRow[]>;
  /** Delete settings whose key starts with `prefix` and that were last written before `before`. */
  deleteSettingsByPrefixBefore(args: { prefix: string; before: Date }): Promise<number>;
  /**
   * Add to a windowed counter kept in instance setting `key` as
   * { window_start, count, errors } (one atomic statement). A counter from an
   * older window starts over. Returns the totals of the current window.
   */
  bumpCounter(args: { key: string; windowStart: number; count: number; errors: number; now: Date }): Promise<{
    count: number;
    errors: number;
  }>;

  /**
   * Send attempts per product and transport since `since`: messages sent
   * since then, messages failed since then after a send attempt (recipient
   * recorded), and messages still 'sending' that were attempted between
   * `since` and `stuckBefore`.
   */
  sendOutcomesSince(args: { since: Date; stuckBefore: Date }): Promise<OpsSendOutcomeRow[]>;
  /** status_reason of messages failed after a send attempt since `since` (at most `limit`, newest first). */
  sendFailureReasonsSince(args: { since: Date; limit: number }): Promise<OpsSendFailureRow[]>;
  /** Sent and failed messages per product since `since` (products with neither are omitted). */
  sendTotalsSince(since: Date): Promise<OpsSendTotalsRow[]>;
  /** Messages awaiting approval per product with the oldest one's creation time. */
  pendingApprovals(): Promise<OpsApprovalsRow[]>;

  /** Every product, oldest first. */
  listProducts(): Promise<OpsProductRow[]>;
  /** Email of the oldest active instance admin, or null. */
  firstInstanceAdminEmail(): Promise<string | null>;
}
