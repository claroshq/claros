/**
 * Operational alerts (G25): pure decisions and mail text. No I/O.
 *
 * Failures are recorded as ops events (packages/worker/src/alerts.ts and the
 * Resend webhook route); each event has a fingerprint (kind + product + the
 * message with ids, numbers and timestamps stripped) that groups repeats into
 * one alert. Alert mail is transactional: plain text plus simple HTML, no
 * List-Unsubscribe, no topic rules.
 */

export const OPS_SEVERITIES = ["warning", "error", "critical"] as const;
export type OpsSeverity = (typeof OPS_SEVERITIES)[number];

/** Event kinds. */
export const OPS_KIND = {
  /** A job failed on every retry (Workers dead letter queue, pg-boss retries exhausted). */
  DEAD_LETTER: "dead_letter",
  /** A job threw inside runJob (each attempt). */
  JOB_FAILED: "job_failed",
  /** A periodic job has not completed for TICK_LATE_FACTOR intervals. */
  TICK_LATE: "tick_late",
  /** More than 20% of a product's sends on one transport failed over 15 minutes. */
  SEND_ERROR_RATE: "send_error_rate",
  /** The provider rejected a transport's credentials (401/403, SMTP 530/535). */
  SEND_AUTH: "send_auth_error",
  /** The drain left approved messages unsent: no usable transport, or no UNSUBSCRIBE_SIGNING_KEY. */
  DRAIN_CONFIG: "drain_config",
  /** 10 or more Resend webhook signature or processing failures in 15 minutes. */
  WEBHOOK_FAILURES: "webhook_failures",
  /** More than 20% of a product's LLM calls (decide, draft, assess) failed over 15 minutes. */
  LLM_ERROR_RATE: "llm_error_rate",
  /** An ingested event or identify was not stored: invalid, or a storage failure answered with 503. */
  INGEST_FAILED: "ingest_failed",
} as const;
export type OpsKind = (typeof OPS_KIND)[keyof typeof OPS_KIND];

/** Thresholds and windows. */
export const ALERT_RULES = {
  sendWindowMinutes: 15,
  sendFailureRate: 0.2,
  sendMinAttempts: 10,
  webhookWindowMinutes: 15,
  webhookFailureThreshold: 10,
  llmWindowMinutes: 15,
  llmErrorRate: 0.2,
  /** Below this many calls in a window the LLM rate is not judged. */
  llmMinCalls: 5,
  /** A fingerprint mails again at most this often ("N more since"). */
  repeatMinutes: 60,
  /** Alert mails per instance per hour; beyond it one "alert storm" mail, the rest go to the digest. */
  mailsPerHour: 10,
  /** An open alert with no occurrence for this long is resolved. */
  cleanWindowMinutes: 60,
  retentionDays: 30,
} as const;

/** Instance setting keys used by alerting. */
export const ALERT_SETTING = {
  /** Recipient address; default: the oldest active instance admin's email. */
  EMAIL: "alerts.email",
  /** false: alerts are recorded and shown on Health, nothing is mailed. Default true. */
  ENABLED: "alerts.enabled",
  /** Product slug whose transactional transport sends alert mail; default: the oldest product with a transport. */
  VIA_PRODUCT: "alerts.via_product",
  /** Internal: alert mails sent in the last hour and the last storm mail. */
  MAIL_LOG: "alerts.mail_log",
  /** Internal: the UTC date of the last digest. */
  DIGEST_LAST: "alerts.digest_last",
} as const;

/** Instance setting key prefixes of the windowed failure counters (one per product). */
export const COUNTER_PREFIX = { LLM: "llm.window.", WEBHOOK: "webhook.window." } as const;

/** Whether alerts of this severity are mailed on their own (warnings go to Health and the digest). */
export function severityMails(severity: string): boolean {
  return severity === "error" || severity === "critical";
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, error: 1, warning: 2 };

/** Sort key: critical first, then error, then warning. */
export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? 3;
}

/** Strip ids, numbers and timestamps from a message so repeats share a fingerprint. */
export function normaliseOpsMessage(message: string): string {
  return message
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/g, "<time>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<id>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** The fingerprint of an event: kind + product + normalised message. */
export function opsFingerprint(kind: string, tenantId: string | null | undefined, message: string): string {
  return `${kind}|${tenantId ?? "-"}|${normaliseOpsMessage(message)}`;
}

/**
 * True when a send failure reason says the provider refused the transport's
 * credentials: Resend or Cloudflare Email Service HTTP 401/403, SMTP 530/535.
 */
export function isProviderAuthError(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return /\berror (?:401|403)\b/.test(reason) || /\bSMTP 53[05]\b/.test(reason);
}

/** Start (ms) of the fixed window of `minutes` that contains `now`. */
export function windowStartMs(now: Date, minutes: number): number {
  const size = minutes * 60_000;
  return Math.floor(now.getTime() / size) * size;
}

// ---------------------------------------------------------------------------
// Mail text
// ---------------------------------------------------------------------------

export interface AlertMail {
  subject: string;
  text: string;
  html: string;
}

export interface AlertMailAlert {
  severity: string;
  kind: string;
  message: string;
  /** Product name or slug, when the alert is about one product. */
  product: string | null;
  firstAt: Date;
  lastAt: Date;
  count: number;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function short(s: string, max = 110): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
}

function iso(d: Date): string {
  return d.toISOString().replace(".000Z", "Z");
}

function page(title: string, paragraphs: string[], footer: string | null): string {
  const body = paragraphs.join("\n");
  return [
    "<!DOCTYPE html>",
    '<html><body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;">',
    `<h1 style="margin:0 0 16px 0;font-size:18px;">${esc(title)}</h1>`,
    body,
    footer ? `<p style="margin:24px 0 0 0;font-size:12px;color:#585d68;">${footer}</p>` : "",
    "</body></html>",
  ].join("\n");
}

function footerText(healthUrl: string | null): string {
  return healthUrl
    ? `Health page: ${healthUrl}\nAlert settings: Settings, Health (instance admins).`
    : "Alert settings: Settings, Health (instance admins).";
}

function footerHtml(healthUrl: string | null): string {
  return healthUrl
    ? `Health page: <a href="${esc(healthUrl)}">${esc(healthUrl)}</a>. Alert settings: Settings, Health (instance admins).`
    : "Alert settings: Settings, Health (instance admins).";
}

function alertLines(a: AlertMailAlert): string[] {
  return [
    `Severity: ${a.severity}`,
    `Kind: ${a.kind}`,
    ...(a.product ? [`Product: ${a.product}`] : []),
    `First seen: ${iso(a.firstAt)}`,
    `Last seen: ${iso(a.lastAt)}`,
    `Occurrences: ${a.count}`,
  ];
}

/** Mail for a new alert, or a repeat with `moreSince` new occurrences since the last mail. */
export function buildAlertMail(a: AlertMailAlert, moreSince: number | null, healthUrl: string | null): AlertMail {
  const repeat = moreSince !== null && moreSince > 0;
  const subject = repeat
    ? `[Claros] ${a.severity}: ${short(a.message)} (${moreSince} more since the last mail)`
    : `[Claros] ${a.severity}: ${short(a.message)}`;
  const lead = repeat
    ? `This alert occurred ${moreSince} more time${moreSince === 1 ? "" : "s"} since the last mail.`
    : "A new operational alert was raised.";
  const lines = alertLines(a);
  const text = [lead, "", a.message, "", ...lines, "", footerText(healthUrl)].join("\n");
  const html = page(
    repeat ? "Alert repeated" : "New alert",
    [
      `<p style="margin:0 0 12px 0;">${esc(lead)}</p>`,
      `<p style="margin:0 0 12px 0;font-family:ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;">${esc(a.message)}</p>`,
      `<p style="margin:0;">${lines.map(esc).join("<br/>")}</p>`,
    ],
    footerHtml(healthUrl),
  );
  return { subject, text, html };
}

/** Short mail when a critical alert resolves. */
export function buildResolvedMail(a: AlertMailAlert, healthUrl: string | null): AlertMail {
  const subject = `[Claros] resolved: ${short(a.message)}`;
  const lead = `This critical alert had no new occurrence for ${ALERT_RULES.cleanWindowMinutes} minutes and is resolved.`;
  const lines = alertLines(a);
  const text = [lead, "", a.message, "", ...lines, "", footerText(healthUrl)].join("\n");
  const html = page(
    "Alert resolved",
    [
      `<p style="margin:0 0 12px 0;">${esc(lead)}</p>`,
      `<p style="margin:0 0 12px 0;font-family:ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;">${esc(a.message)}</p>`,
      `<p style="margin:0;">${lines.map(esc).join("<br/>")}</p>`,
    ],
    footerHtml(healthUrl),
  );
  return { subject, text, html };
}

/** One mail when the hourly cap is reached: the alerts it covers go to the digest. */
export function buildStormMail(alerts: AlertMailAlert[], healthUrl: string | null): AlertMail {
  const subject = `[Claros] alert storm: ${alerts.length} more alert${alerts.length === 1 ? "" : "s"} this hour`;
  const lead =
    `More than ${ALERT_RULES.mailsPerHour} alert mails were due within an hour. ` +
    "These alerts are not mailed one by one; they appear on the Health page and in the daily digest.";
  const rows = alerts.map((a) => `- ${a.severity}${a.product ? ` [${a.product}]` : ""}: ${short(a.message, 160)} (${a.count}x)`);
  const text = [lead, "", ...rows, "", footerText(healthUrl)].join("\n");
  const html = page(
    "Alert storm",
    [
      `<p style="margin:0 0 12px 0;">${esc(lead)}</p>`,
      `<ul style="margin:0;padding-left:20px;">${alerts
        .map(
          (a) =>
            `<li>${esc(a.severity)}${a.product ? ` [${esc(a.product)}]` : ""}: ${esc(short(a.message, 160))} (${a.count}x)</li>`,
        )
        .join("")}</ul>`,
    ],
    footerHtml(healthUrl),
  );
  return { subject, text, html };
}

export interface DigestInput {
  now: Date;
  openAlerts: AlertMailAlert[];
  /** Last 24 hours of events grouped by fingerprint. */
  events: Array<{ severity: string; kind: string; message: string; product: string | null; count: number; lastAt: Date }>;
  /** Dead letters plus job failures in the last 24 hours. */
  failedJobs: number;
  sends: Array<{ product: string; sent: number; failed: number }>;
  approvals: Array<{ product: string; pending: number; oldestAt: Date | null }>;
}

/** True when the digest has nothing to report (it is then not sent). */
export function digestIsEmpty(d: DigestInput): boolean {
  return (
    d.openAlerts.length === 0 &&
    d.events.length === 0 &&
    d.failedJobs === 0 &&
    d.approvals.every((a) => a.pending === 0)
  );
}

/** The daily digest mail. */
export function buildDigestMail(d: DigestInput, healthUrl: string | null): AlertMail {
  const subject = `[Claros] daily digest: ${d.openAlerts.length} open alert${d.openAlerts.length === 1 ? "" : "s"}`;
  const text: string[] = [`Claros daily digest, ${iso(d.now)}`, ""];
  const html: string[] = [];

  const section = (title: string, lines: string[]) => {
    text.push(title, ...(lines.length ? lines : ["- none"]), "");
    html.push(
      `<h2 style="margin:20px 0 8px 0;font-size:15px;">${esc(title)}</h2>`,
      lines.length
        ? `<ul style="margin:0;padding-left:20px;">${lines.map((l) => `<li>${esc(l.replace(/^- /, ""))}</li>`).join("")}</ul>`
        : '<p style="margin:0;color:#585d68;">None.</p>',
    );
  };

  section(
    "Open alerts",
    d.openAlerts.map(
      (a) => `- ${a.severity}${a.product ? ` [${a.product}]` : ""}: ${short(a.message, 160)} (${a.count}x, last ${iso(a.lastAt)})`,
    ),
  );
  section(
    "Events in the last 24 hours",
    d.events.map((e) => `- ${e.count}x ${e.severity}${e.product ? ` [${e.product}]` : ""}: ${short(e.message, 160)}`),
  );
  section("Failed jobs in the last 24 hours", [`- ${d.failedJobs} (dead letters and job failures)`]);
  section(
    "Sends in the last 24 hours",
    d.sends.map((s) => `- ${s.product}: ${s.sent} sent, ${s.failed} failed`),
  );
  section(
    "Pending approvals",
    d.approvals
      .filter((a) => a.pending > 0)
      .map((a) => `- ${a.product}: ${a.pending} pending${a.oldestAt ? `, oldest from ${iso(a.oldestAt)}` : ""}`),
  );
  text.push(footerText(healthUrl));

  return { subject, text: text.join("\n"), html: page("Daily digest", html, footerHtml(healthUrl)) };
}
