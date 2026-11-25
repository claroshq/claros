/**
 * Operational alerts (G25): failures reach a human.
 *
 * Recording (each writes an ops_event; the fingerprint groups repeats into
 * one ops_alert):
 *   - recordJobFailure       a job threw inside runJob (error)
 *   - recordDeadLetter       a job failed on every retry (error)
 *   - recordTickRun          heartbeat: instance setting tick.<name> after each periodic run
 *   - checkLateTicks         a periodic job older than 3 intervals (error), in the content tick
 *   - recordDrainFaults      approved messages left unsent: no transport / no signing key (critical)
 *   - checkSendErrors        >20% failed sends per product and transport over 15 minutes with
 *                            at least 10 attempts (error), provider auth errors (critical), in the drain tick
 *   - recordLlmCalls         >20% failed LLM calls per product in a 15-minute window (warning)
 *   (Resend webhook failures are recorded by the API route, packages/api/src/ops-events.ts.)
 *
 * Delivery (runAlertTick, in the content tick every 5 minutes; runDigest, daily 07:00 UTC):
 *   - recipient: instance setting alerts.email, else the oldest instance admin
 *   - alerts.enabled (default true); false records and shows alerts but mails nothing
 *   - transport: the transactional route of alerts.via_product, else of the
 *     oldest product with a usable transport; alert mail is transactional
 *     (no List-Unsubscribe, no topic rules)
 *   - an error or critical alert mails within one tick, repeats at most hourly
 *     ("N more since"), at most 10 alert mails per hour per instance; beyond
 *     that one "alert storm" mail and the rest wait for the digest
 *   - an open alert without an occurrence for 60 minutes resolves; a critical
 *     one that was mailed gets a short resolved mail
 *   - a failed alert send is logged and never raises another alert
 *
 * Every function here catches its own errors: recording or mailing an alert
 * must never fail the job that triggered it.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  ALERT_RULES,
  ALERT_SETTING,
  COUNTER_PREFIX,
  OPS_KIND,
  QUEUE,
  TICK_INTERVAL_MINUTES,
  TICK_LATE_FACTOR,
  buildAlertMail,
  buildDigestMail,
  buildResolvedMail,
  buildStormMail,
  digestIsEmpty,
  isProviderAuthError,
  opsFingerprint,
  severityMails,
  severityRank,
  tickName,
  windowStartMs,
  type AlertMail,
  type AlertMailAlert,
  type OpsSeverity,
} from "@claros/core";
import { storeFor, type OpsAlertRow } from "@claros/store";
import type { TenantTransportAdapter, TransportResolver } from "./transport.js";
import { buildTenantTransportResolver } from "./transport-resolver.js";
import type { DrainConfigFault } from "./drain.js";
import type { LlmCallStats } from "./content.js";

type Db = NodePgDatabase<Record<string, never>>;

const MINUTE = 60_000;

export { ALERT_SETTING, COUNTER_PREFIX };

function log(what: string, err: unknown): void {
  console.error(`[alerts] ${what}:`, err instanceof Error ? err.message : err);
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface OpsEventSpec {
  kind: string;
  severity: OpsSeverity;
  tenantId?: string | null;
  message: string;
  context?: Record<string, unknown> | null;
}

/** Record an event and open or bump its alert. Never throws. */
export async function recordOpsEvent(db: Db, spec: OpsEventSpec, now: Date = new Date()): Promise<void> {
  const tenantId = spec.tenantId ?? null;
  try {
    await storeFor(db).ops.recordEvent(
      {
        at: now,
        tenantId,
        kind: spec.kind,
        severity: spec.severity,
        fingerprint: opsFingerprint(spec.kind, tenantId, spec.message),
        message: spec.message.slice(0, 2000),
        context: spec.context ?? null,
      },
      { alert: true },
    );
  } catch (err) {
    log(`could not record ${spec.kind} event`, err);
  }
}

function tenantOf(data: unknown): string | null {
  const t = (data as Record<string, unknown> | null | undefined)?.tenant_id;
  return typeof t === "string" && t.length > 0 ? t : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A job threw inside runJob. */
export async function recordJobFailure(db: Db, job: string, data: unknown, err: unknown, now = new Date()): Promise<void> {
  await recordOpsEvent(
    db,
    {
      kind: OPS_KIND.JOB_FAILED,
      severity: "error",
      tenantId: tenantOf(data),
      message: `Job ${job} failed: ${errorText(err)}`,
      context: { job, data: (data ?? null) as Record<string, unknown> | null },
    },
    now,
  );
}

/** A job failed on every retry (Workers dead letter queue, pg-boss retries exhausted). */
export async function recordDeadLetter(
  db: Db,
  job: string,
  data: unknown,
  attempts: number | null,
  err: unknown = null,
  now = new Date(),
): Promise<void> {
  const detail = err === null ? "" : `: ${errorText(err)}`;
  await recordOpsEvent(
    db,
    {
      kind: OPS_KIND.DEAD_LETTER,
      severity: "error",
      tenantId: tenantOf(data),
      message: `Job ${job} failed on every retry and was dropped${detail}`,
      context: { job, attempts, data: (data ?? null) as Record<string, unknown> | null },
    },
    now,
  );
}

/** Heartbeat: the periodic job completed. */
export async function recordTickRun(db: Db, queue: string, now = new Date()): Promise<void> {
  try {
    await storeFor(db).ops.putSetting({ key: `tick.${tickName(queue)}`, value: { last_run_at: now.toISOString() }, now });
  } catch (err) {
    log(`could not record the ${queue} heartbeat`, err);
  }
}

/** Raise "tick late" for periodic jobs whose last run is older than TICK_LATE_FACTOR intervals. */
export async function checkLateTicks(db: Db, now = new Date()): Promise<string[]> {
  const late: string[] = [];
  try {
    const store = storeFor(db);
    const beats = new Map((await store.ops.listSettingsByPrefix("tick.")).map((r) => [r.key, r.value]));
    for (const [queue, interval] of Object.entries(TICK_INTERVAL_MINUTES)) {
      // Partition maintenance exists on Postgres only.
      if (queue === QUEUE.PARTITION_MAINTENANCE && store.dialect !== "pg") continue;
      const name = tickName(queue);
      const beat = beats.get(`tick.${name}`) as { last_run_at?: unknown } | undefined;
      const lastRun = typeof beat?.last_run_at === "string" ? new Date(beat.last_run_at) : null;
      // A job that never ran is not judged (fresh installs, roles not started yet).
      if (lastRun === null || Number.isNaN(lastRun.getTime())) continue;
      if (now.getTime() - lastRun.getTime() <= interval * TICK_LATE_FACTOR * MINUTE) continue;
      late.push(name);
      await recordOpsEvent(
        db,
        {
          kind: OPS_KIND.TICK_LATE,
          severity: "error",
          message: `Periodic job ${name} is late: last completed run ${lastRun.toISOString()}, expected every ${interval} minutes.`,
          context: { job: queue, last_run_at: lastRun.toISOString(), interval_minutes: interval },
        },
        now,
      );
    }
  } catch (err) {
    log("tick check failed", err);
  }
  return late;
}

/** Approved messages left unsent by a configuration fault (from the drain tick). */
export async function recordDrainFaults(db: Db, faults: DrainConfigFault[], now = new Date()): Promise<void> {
  let signingKeyRecorded = false;
  for (const f of faults) {
    if (f.fault === "no_signing_key") {
      // An instance-wide setting: one event, not one per product.
      if (signingKeyRecorded) continue;
      signingKeyRecorded = true;
      await recordOpsEvent(
        db,
        {
          kind: OPS_KIND.DRAIN_CONFIG,
          severity: "critical",
          message: "UNSUBSCRIBE_SIGNING_KEY is not set: the drain returned approved messages to the queue unsent.",
          context: { fault: f.fault },
        },
        now,
      );
    } else {
      await recordOpsEvent(
        db,
        {
          kind: OPS_KIND.DRAIN_CONFIG,
          severity: "critical",
          tenantId: f.tenantId,
          message:
            "Approved messages are not being sent: the product has no usable transport " +
            "(none active, or its credentials cannot be decrypted with ENCRYPTION_KEY).",
          context: { fault: f.fault },
        },
        now,
      );
    }
  }
}

function transportLabel(kind: string | null, name: string | null): string {
  return `${kind ?? "unknown"} transport${name ? ` "${name}"` : ""}`;
}

/**
 * Send errors per product and transport over the last 15 minutes (from the
 * drain tick): failure rate above 20% with at least 10 attempts (error),
 * any provider authentication error (critical).
 */
export async function checkSendErrors(db: Db, now = new Date()): Promise<void> {
  try {
    const store = storeFor(db).ops;
    const since = new Date(now.getTime() - ALERT_RULES.sendWindowMinutes * MINUTE);
    // A message still 'sending' 2 minutes after its attempt hit a transient error.
    const stuckBefore = new Date(now.getTime() - 2 * MINUTE);
    for (const r of await store.sendOutcomesSince({ since, stuckBefore })) {
      const failures = r.failed + r.stuck;
      const attempts = r.sent + failures;
      if (attempts < ALERT_RULES.sendMinAttempts || failures / attempts <= ALERT_RULES.sendFailureRate) continue;
      await recordOpsEvent(
        db,
        {
          kind: OPS_KIND.SEND_ERROR_RATE,
          severity: "error",
          tenantId: r.tenantId,
          message:
            `More than ${Math.round(ALERT_RULES.sendFailureRate * 100)}% of sends failed on the ` +
            `${transportLabel(r.transportKind, r.transportName)} in the last ${ALERT_RULES.sendWindowMinutes} minutes ` +
            `(${failures} of ${attempts}).`,
          context: { transport_id: r.transportId, sent: r.sent, failed: r.failed, stuck: r.stuck },
        },
        now,
      );
    }

    const authSeen = new Set<string>();
    for (const f of await store.sendFailureReasonsSince({ since, limit: 500 })) {
      if (!isProviderAuthError(f.reason)) continue;
      const key = `${f.tenantId}|${f.transportId ?? "-"}`;
      if (authSeen.has(key)) continue;
      authSeen.add(key);
      await recordOpsEvent(
        db,
        {
          kind: OPS_KIND.SEND_AUTH,
          severity: "critical",
          tenantId: f.tenantId,
          message:
            `The provider refused the credentials of the ${transportLabel(f.transportKind, null)}. ` +
            "Check its API key or SMTP login in Settings, Transports.",
          context: { transport_id: f.transportId, reason: f.reason },
        },
        now,
      );
    }
  } catch (err) {
    log("send error check failed", err);
  }
}

function overRate(count: number, errors: number, min: number, rate: number): boolean {
  return count >= min && errors / count > rate;
}

/** LLM calls of one product (from the content tick or a process-message job). */
export async function recordLlmCalls(db: Db, tenantId: string, stats: LlmCallStats, now = new Date()): Promise<void> {
  if (stats.calls <= 0) return;
  try {
    const store = storeFor(db).ops;
    const total = await store.bumpCounter({
      key: `${COUNTER_PREFIX.LLM}${tenantId}`,
      windowStart: windowStartMs(now, ALERT_RULES.llmWindowMinutes),
      count: stats.calls,
      errors: stats.errors,
      now,
    });
    const { llmMinCalls: min, llmErrorRate: rate } = ALERT_RULES;
    if (!overRate(total.count, total.errors, min, rate)) return;
    const message =
      `More than ${Math.round(rate * 100)}% of LLM calls (decide, draft, assess) failed in the current ` +
      `${ALERT_RULES.llmWindowMinutes}-minute window.`;
    // One event when the window crosses the threshold; later runs only keep the alert fresh.
    if (overRate(total.count - stats.calls, total.errors - stats.errors, min, rate)) {
      const touched = await store.touchAlert({ fingerprint: opsFingerprint(OPS_KIND.LLM_ERROR_RATE, tenantId, message), at: now });
      if (touched) return;
    }
    await recordOpsEvent(
      db,
      {
        kind: OPS_KIND.LLM_ERROR_RATE,
        severity: "warning",
        tenantId,
        message,
        context: { calls: total.count, errors: total.errors },
      },
      now,
    );
  } catch (err) {
    log("LLM call accounting failed", err);
  }
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export interface AlertDeliveryDeps {
  /** Transport resolver (tests inject one); default: the database resolver. */
  resolveTransport?: TransportResolver;
}

interface AlertSettings {
  enabled: boolean;
  email: string | null;
  viaProduct: string | null;
}

async function readAlertSettings(db: Db): Promise<AlertSettings> {
  const store = storeFor(db).ops;
  const [enabled, email, via] = await Promise.all([
    store.getSetting(ALERT_SETTING.ENABLED),
    store.getSetting(ALERT_SETTING.EMAIL),
    store.getSetting(ALERT_SETTING.VIA_PRODUCT),
  ]);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    enabled: enabled?.value !== false && enabled?.value !== "false",
    email: str(email?.value),
    viaProduct: str(via?.value),
  };
}

interface Mailer {
  send(to: string, mail: AlertMail): Promise<boolean>;
}

/**
 * The transport alert mail goes through: the transactional route of
 * alerts.via_product, else of the oldest product with a usable transport.
 */
async function alertMailer(db: Db, settings: AlertSettings, deps: AlertDeliveryDeps): Promise<Mailer | null> {
  const resolve = deps.resolveTransport ?? buildTenantTransportResolver(db);
  const products = await storeFor(db).ops.listProducts();
  const ordered = settings.viaProduct
    ? [...products.filter((p) => p.slug === settings.viaProduct), ...products.filter((p) => p.slug !== settings.viaProduct)]
    : products;
  let adapter: TenantTransportAdapter | null = null;
  let tenantId: string | null = null;
  for (const p of ordered) {
    adapter = await resolve(p.id, "transactional");
    if (adapter) {
      tenantId = p.id;
      break;
    }
  }
  if (!adapter || !tenantId) return null;

  const info = adapter.transportInfo;
  const sender = info
    ? { fromEmail: info.fromEmail }
    : ((await storeFor(db).workerDrain.getSender(tenantId)) ?? { fromEmail: "noreply@localhost" });
  const chosen = adapter;
  return {
    async send(to, mail) {
      try {
        const result = await chosen.send({
          to,
          from: sender.fromEmail,
          fromName: "Claros alerts",
          subject: mail.subject,
          bodyHtml: mail.html,
          bodyText: mail.text,
          // Transactional: no List-Unsubscribe.
          headers: {},
          tags: { claros_alert: "ops" },
          messageId: crypto.randomUUID(),
        });
        if (!result.success) {
          console.error(`[alerts] alert mail to ${to} failed: ${result.error ?? "unknown error"}`);
          return false;
        }
        return true;
      } catch (err) {
        log(`alert mail to ${to} failed`, err);
        return false;
      }
    },
  };
}

async function recipient(db: Db, settings: AlertSettings): Promise<string | null> {
  return settings.email ?? (await storeFor(db).ops.firstInstanceAdminEmail());
}

function healthUrl(): string | null {
  const base = process.env.DASHBOARD_URL || process.env.BASE_URL;
  return base ? `${base.replace(/\/+$/, "")}/settings/health` : null;
}

async function productNames(db: Db): Promise<Map<string, string>> {
  return new Map((await storeFor(db).ops.listProducts()).map((p) => [p.id, p.name || p.slug]));
}

function toMailAlert(a: OpsAlertRow, names: Map<string, string>): AlertMailAlert {
  return {
    severity: a.severity,
    kind: a.kind,
    message: a.message,
    product: a.tenantId ? (names.get(a.tenantId) ?? a.tenantId) : null,
    firstAt: a.firstAt,
    lastAt: a.lastAt,
    count: a.count,
  };
}

function muted(a: OpsAlertRow, now: Date): boolean {
  return a.mutedUntil !== null && a.mutedUntil.getTime() > now.getTime();
}

/** Alerts due for a mail now: error/critical, not muted, new, or repeated with new occurrences after the repeat interval. */
export function dueForMail(alerts: OpsAlertRow[], now: Date): OpsAlertRow[] {
  return alerts
    .filter((a) => a.status === "open" && severityMails(a.severity) && !muted(a, now))
    .filter(
      (a) =>
        a.lastNotifiedAt === null ||
        (a.count > a.notifiedCount && now.getTime() - a.lastNotifiedAt.getTime() >= ALERT_RULES.repeatMinutes * MINUTE),
    )
    .sort((x, y) => severityRank(x.severity) - severityRank(y.severity) || x.firstAt.getTime() - y.firstAt.getTime());
}

export interface AlertTickResult {
  lateTicks: string[];
  resolved: number;
  mailed: number;
  storm: boolean;
  /** Why nothing was mailed, when alerts were due. */
  skipped?: "disabled" | "no_recipient" | "no_transport";
}

/**
 * The alert tick (in the content tick): late-tick check, resolution of
 * alerts with a clean window, then alert mail.
 */
export async function runAlertTick(db: Db, deps: AlertDeliveryDeps = {}, now = new Date()): Promise<AlertTickResult> {
  const result: AlertTickResult = { lateTicks: [], resolved: 0, mailed: 0, storm: false };
  result.lateTicks = await checkLateTicks(db, now);
  try {
    const store = storeFor(db).ops;
    const resolved = await store.resolveStaleAlerts({
      before: new Date(now.getTime() - ALERT_RULES.cleanWindowMinutes * MINUTE),
    });
    result.resolved = resolved.length;

    const open = await store.listAlerts({ status: "open", limit: 1000 });
    const due = dueForMail(open, now);
    const resolvedCritical = resolved.filter((a) => a.severity === "critical" && a.lastNotifiedAt !== null && !muted(a, now));
    if (due.length === 0 && resolvedCritical.length === 0) return result;

    const settings = await readAlertSettings(db);
    if (!settings.enabled) {
      result.skipped = "disabled";
      return result;
    }
    const to = await recipient(db, settings);
    if (!to) {
      console.warn("[alerts] alerts are due but no recipient is set (alerts.email) and there is no instance admin.");
      result.skipped = "no_recipient";
      return result;
    }
    const mailer = await alertMailer(db, settings, deps);
    if (!mailer) {
      console.warn("[alerts] alerts are due but no product has a usable transport to send them.");
      result.skipped = "no_transport";
      return result;
    }

    const names = await productNames(db);
    const url = healthUrl();
    const logRow = await store.getSetting(ALERT_SETTING.MAIL_LOG);
    const prev = (logRow?.value ?? {}) as { sent?: unknown; storm_at?: unknown };
    const hourAgo = now.getTime() - 60 * MINUTE;
    const sent = (Array.isArray(prev.sent) ? prev.sent : []).filter((t): t is number => typeof t === "number" && t > hourAgo);
    let stormAt = typeof prev.storm_at === "number" ? prev.storm_at : null;
    let budget = ALERT_RULES.mailsPerHour - sent.length;
    const overflow: OpsAlertRow[] = [];

    for (const a of due) {
      if (budget <= 0) {
        overflow.push(a);
        continue;
      }
      // Claim first: a concurrent tick never mails the same alert twice. A
      // failed send is not retried before the next repeat interval.
      if (!(await store.claimNotification({ fingerprint: a.fingerprint, expectedLastNotifiedAt: a.lastNotifiedAt, at: now }))) continue;
      const moreSince = a.lastNotifiedAt === null ? null : a.count - a.notifiedCount;
      budget--;
      sent.push(now.getTime());
      if (await mailer.send(to, buildAlertMail(toMailAlert(a, names), moreSince, url))) result.mailed++;
    }

    for (const a of resolvedCritical) {
      if (budget <= 0) break;
      budget--;
      sent.push(now.getTime());
      if (await mailer.send(to, buildResolvedMail(toMailAlert(a, names), url))) result.mailed++;
    }

    if (overflow.length > 0) {
      const claimed: OpsAlertRow[] = [];
      for (const a of overflow) {
        if (await store.claimNotification({ fingerprint: a.fingerprint, expectedLastNotifiedAt: a.lastNotifiedAt, at: now })) {
          claimed.push(a);
        }
      }
      if (claimed.length > 0 && (stormAt === null || stormAt <= hourAgo)) {
        stormAt = now.getTime();
        result.storm = true;
        await mailer.send(to, buildStormMail(claimed.map((a) => toMailAlert(a, names)), url));
      }
    }

    await store.putSetting({ key: ALERT_SETTING.MAIL_LOG, value: { sent, storm_at: stormAt }, now });
  } catch (err) {
    log("alert tick failed", err);
  }
  return result;
}

export interface DigestResult {
  sent: boolean;
  skipped?: "disabled" | "empty" | "already_sent" | "no_recipient" | "no_transport";
  deletedEvents: number;
}

/** The daily digest (07:00 UTC) and the retention of ops data. */
export async function runDigest(db: Db, deps: AlertDeliveryDeps = {}, now = new Date()): Promise<DigestResult> {
  const result: DigestResult = { sent: false, deletedEvents: 0 };
  const store = storeFor(db).ops;
  try {
    const cutoff = new Date(now.getTime() - ALERT_RULES.retentionDays * 24 * 60 * MINUTE);
    result.deletedEvents = await store.deleteEventsBefore(cutoff);
    await store.deleteResolvedAlertsBefore(cutoff);
    const dayAgo = new Date(now.getTime() - 24 * 60 * MINUTE);
    await store.deleteSettingsByPrefixBefore({ prefix: COUNTER_PREFIX.LLM, before: dayAgo });
    await store.deleteSettingsByPrefixBefore({ prefix: COUNTER_PREFIX.WEBHOOK, before: dayAgo });
  } catch (err) {
    log("ops retention failed", err);
  }

  try {
    const settings = await readAlertSettings(db);
    if (!settings.enabled) return { ...result, skipped: "disabled" };
    const today = now.toISOString().slice(0, 10);
    const last = await store.getSetting(ALERT_SETTING.DIGEST_LAST);
    if (last?.value === today) return { ...result, skipped: "already_sent" };

    const since = new Date(now.getTime() - 24 * 60 * MINUTE);
    const names = await productNames(db);
    const product = (id: string | null) => (id ? (names.get(id) ?? id) : null);
    const [open, groups, failedJobs, sends, approvals] = await Promise.all([
      store.listAlerts({ status: "open", limit: 200 }),
      store.groupEventsSince({ since }),
      store.countEventsSince({ kinds: [OPS_KIND.DEAD_LETTER, OPS_KIND.JOB_FAILED], since }),
      store.sendTotalsSince(since),
      store.pendingApprovals(),
    ]);
    const input = {
      now,
      openAlerts: open.map((a) => toMailAlert(a, names)),
      events: groups.map((g) => ({
        severity: g.severity,
        kind: g.kind,
        message: g.message,
        product: product(g.tenantId),
        count: g.count,
        lastAt: g.lastAt,
      })),
      failedJobs,
      sends: sends.map((s) => ({ product: product(s.tenantId) ?? s.tenantId, sent: s.sent, failed: s.failed })),
      approvals: approvals.map((a) => ({ product: product(a.tenantId) ?? a.tenantId, pending: a.pending, oldestAt: a.oldestAt })),
    };
    if (digestIsEmpty(input)) return { ...result, skipped: "empty" };

    const to = await recipient(db, settings);
    if (!to) return { ...result, skipped: "no_recipient" };
    const mailer = await alertMailer(db, settings, deps);
    if (!mailer) return { ...result, skipped: "no_transport" };
    await store.putSetting({ key: ALERT_SETTING.DIGEST_LAST, value: today, now });
    result.sent = await mailer.send(to, buildDigestMail(input, healthUrl()));
  } catch (err) {
    log("digest failed", err);
  }
  return result;
}
