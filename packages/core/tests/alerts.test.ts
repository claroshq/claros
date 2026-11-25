import { describe, it, expect } from "vitest";
import {
  ALERT_RULES,
  buildAlertMail,
  buildDigestMail,
  buildResolvedMail,
  buildStormMail,
  digestIsEmpty,
  isProviderAuthError,
  normaliseOpsMessage,
  opsFingerprint,
  severityMails,
  severityRank,
  windowStartMs,
  type AlertMailAlert,
  type DigestInput,
} from "../src/index.js";

const alert: AlertMailAlert = {
  severity: "error",
  kind: "dead_letter",
  message: "Job claros.compile failed on every retry and was dropped: <boom>",
  product: "Acme",
  firstAt: new Date("2026-11-25T10:00:00Z"),
  lastAt: new Date("2026-11-25T10:05:00Z"),
  count: 3,
};

describe("fingerprints", () => {
  it("strip ids, numbers and timestamps so repeats group", () => {
    const a = "Job claros.drain-message failed: message 3f1c2a9e-1b2c-4d5e-8f90-123456789abc timed out after 30000 ms at 2026-11-25T10:00:00.123Z";
    const b = "Job claros.drain-message failed: message 0a1b2c3d-4e5f-4a6b-8c7d-0123456789ab timed out after 1200 ms at 2026-11-26 11:01:02+00";
    expect(normaliseOpsMessage(a)).toBe(normaliseOpsMessage(b));
    expect(normaliseOpsMessage(a)).toBe("Job claros.drain-message failed: message <id> timed out after <n> ms at <time>");
    expect(normaliseOpsMessage("token deadbeefdeadbeefdeadbeef seen")).toBe("token <id> seen");
  });

  it("include kind and product", () => {
    expect(opsFingerprint("job_failed", "t1", "x 1")).toBe("job_failed|t1|x <n>");
    expect(opsFingerprint("job_failed", null, "x 2")).toBe("job_failed|-|x <n>");
    expect(opsFingerprint("job_failed", "t1", "x")).not.toBe(opsFingerprint("job_failed", "t2", "x"));
    expect(opsFingerprint("job_failed", "t1", "x")).not.toBe(opsFingerprint("dead_letter", "t1", "x"));
  });

  it("are bounded in length", () => {
    expect(normaliseOpsMessage("x ".repeat(1000))).toHaveLength(200);
  });
});

describe("rules", () => {
  it("only error and critical mail", () => {
    expect(severityMails("warning")).toBe(false);
    expect(severityMails("error")).toBe(true);
    expect(severityMails("critical")).toBe(true);
    expect(severityRank("critical")).toBeLessThan(severityRank("error"));
    expect(severityRank("error")).toBeLessThan(severityRank("warning"));
  });

  it("provider auth errors: Resend and Cloudflare 401/403, SMTP 530/535", () => {
    expect(isProviderAuthError("provider_error: Resend error 401 (missing_api_key): Missing API key")).toBe(true);
    expect(isProviderAuthError("provider_error: Resend error 403 (invalid_api_key): API key is invalid")).toBe(true);
    expect(isProviderAuthError("provider_error: Cloudflare Email Service error 403: 10000 Authentication error")).toBe(true);
    expect(isProviderAuthError("provider_error: SMTP 535: 5.7.8 Authentication failed")).toBe(true);
    expect(isProviderAuthError("provider_error: Resend error 422 (validation_error): bad")).toBe(false);
    expect(isProviderAuthError("provider_error: SMTP 550: mailbox unavailable")).toBe(false);
    expect(isProviderAuthError("topic_unsubscribed")).toBe(false);
    expect(isProviderAuthError(null)).toBe(false);
  });

  it("windows are fixed and aligned", () => {
    const start = windowStartMs(new Date("2026-11-25T10:14:59Z"), 15);
    expect(new Date(start).toISOString()).toBe("2026-11-25T10:00:00.000Z");
    expect(windowStartMs(new Date("2026-11-25T10:15:00Z"), 15)).toBe(start + 15 * 60_000);
  });
});

describe("mail text", () => {
  it("a new alert names severity, message, product and counts; no em dashes", () => {
    const m = buildAlertMail(alert, null, "https://claros.example.com/settings/health");
    expect(m.subject).toBe(`[Claros] error: ${alert.message}`);
    expect(m.text).toContain("Product: Acme");
    expect(m.text).toContain("Occurrences: 3");
    expect(m.text).toContain("https://claros.example.com/settings/health");
    expect(m.html).toContain("&lt;boom&gt;");
    expect(m.html).not.toContain("<boom>");
    for (const s of [m.subject, m.text, m.html]) expect(s).not.toContain("—");
  });

  it("a repeat says how many more since the last mail", () => {
    const m = buildAlertMail(alert, 50, null);
    expect(m.subject).toContain("(50 more since the last mail)");
    expect(m.text).toContain("occurred 50 more times since the last mail");
  });

  it("resolved and storm mails", () => {
    expect(buildResolvedMail({ ...alert, severity: "critical" }, null).subject).toBe(`[Claros] resolved: ${alert.message}`);
    const storm = buildStormMail([alert, { ...alert, product: null }], null);
    expect(storm.subject).toBe("[Claros] alert storm: 2 more alerts this hour");
    expect(storm.text).toContain(`More than ${ALERT_RULES.mailsPerHour} alert mails`);
  });

  it("the digest lists every section and is empty when nothing happened", () => {
    const empty: DigestInput = {
      now: new Date("2026-11-25T07:00:00Z"),
      openAlerts: [],
      events: [],
      failedJobs: 0,
      sends: [{ product: "Acme", sent: 10, failed: 0 }],
      approvals: [{ product: "Acme", pending: 0, oldestAt: null }],
    };
    expect(digestIsEmpty(empty)).toBe(true);
    const full: DigestInput = {
      ...empty,
      openAlerts: [alert],
      events: [{ severity: "error", kind: "dead_letter", message: alert.message, product: "Acme", count: 51, lastAt: alert.lastAt }],
      failedJobs: 51,
      approvals: [{ product: "Acme", pending: 2, oldestAt: new Date("2026-11-24T00:00:00Z") }],
    };
    expect(digestIsEmpty(full)).toBe(false);
    const m = buildDigestMail(full, null);
    expect(m.subject).toBe("[Claros] daily digest: 1 open alert");
    expect(m.text).toContain("- 51x error [Acme]");
    expect(m.text).toContain("- Acme: 10 sent, 0 failed");
    expect(m.text).toContain("- Acme: 2 pending, oldest from 2026-11-24T00:00:00Z");
    expect(m.text).toContain("- 51 (dead letters and job failures)");
  });
});
