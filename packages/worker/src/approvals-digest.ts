/**
 * Daily waiting-approvals mail (P5b, settings.approvals.daily_digest).
 *
 * Once per product and local day, from 08:00 in the product's timezone
 * (throttle.tenant_timezone, else UTC), the product's owners get one mail
 * listing how many drafts wait for approval, sent through the product's
 * transactional route (no List-Unsubscribe headers). Nothing is sent when no
 * draft waits. A day is claimed atomically (tenant_daily_usage) before the
 * mail goes out, so a digest is never sent twice; a product without a usable
 * transactional transport is left unclaimed and retried on the next tick.
 * Runs on the content tick, on both runtimes.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor } from "@claros/store";
import { resolveTimezone } from "@claros/core";
import type { TransportResolver } from "./transport.js";
import { buildTenantTransportResolver } from "./transport-resolver.js";

type Db = NodePgDatabase<Record<string, never>>;

/** Local hour the digest is due from. */
export const APPROVALS_DIGEST_HOUR = 8;

export interface ApprovalsDigestResult {
  /** Products whose digest went out this run. */
  sent: string[];
}

/** Local date ("YYYY-MM-DD") and hour of a time in a timezone. */
export function localDateHour(now: Date, timezone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24 };
}

function digestEnabled(settings: unknown): boolean {
  const a = (settings as { approvals?: { daily_digest?: unknown } } | null)?.approvals;
  return a?.daily_digest === true;
}

function productTimezone(settings: unknown): string {
  const tz = (settings as { throttle?: { tenant_timezone?: unknown } } | null)?.throttle?.tenant_timezone;
  return resolveTimezone(null, typeof tz === "string" ? tz : null);
}

function approvalsUrl(slug: string): string | null {
  const base = process.env.DASHBOARD_URL || process.env.BASE_URL;
  return base ? `${base.replace(/\/+$/, "")}/approvals?product=${encodeURIComponent(slug)}` : null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function runApprovalsDigest(
  db: Db,
  now: Date,
  deps: { resolveTransport?: TransportResolver } = {},
): Promise<ApprovalsDigestResult> {
  const store = storeFor(db).workerApprovalsDigest;
  const result: ApprovalsDigestResult = { sent: [] };
  const products = (await store.listActiveProducts()).filter((p) => digestEnabled(p.settings));
  if (products.length === 0) return result;
  const resolve = deps.resolveTransport ?? buildTenantTransportResolver(db);

  for (const p of products) {
    const { date, hour } = localDateHour(now, productTimezone(p.settings));
    if (hour < APPROVALS_DIGEST_HOUR) continue;
    const waiting = await store.countPendingApprovals(p.id);
    const owners = await store.listOwnerEmails(p.id);
    if (waiting === 0 || owners.length === 0) continue;
    const adapter = await resolve(p.id, "transactional");
    if (!adapter) continue;
    if (!(await store.claimDigest({ tenantId: p.id, day: date, now }))) continue;

    const sender = adapter.transportInfo
      ? { fromEmail: adapter.transportInfo.fromEmail, fromName: adapter.transportInfo.fromName }
      : ((await storeFor(db).workerDrain.getSender(p.id)) ?? { fromEmail: "noreply@localhost", fromName: null });
    const name = p.name || p.slug;
    const subject = `${waiting} ${waiting === 1 ? "draft waits" : "drafts wait"} for approval in ${name}`;
    const url = approvalsUrl(p.slug);
    const text = [
      `${subject}.`,
      "",
      url ? `Review them: ${url}` : "Review them on the Approvals page of the dashboard.",
      "",
      `You get this mail once a day because ${name} has approvals.daily_digest turned on.`,
    ].join("\n");
    const html =
      `<p>${escapeHtml(subject)}.</p>` +
      (url ? `<p><a href="${escapeHtml(url)}">Review them</a></p>` : "<p>Review them on the Approvals page of the dashboard.</p>") +
      `<p style="color:#6b7280;font-size:12px">You get this mail once a day because ${escapeHtml(name)} has approvals.daily_digest turned on.</p>`;
    let delivered = false;
    for (const to of owners) {
      try {
        const r = await adapter.send({
          to,
          from: sender.fromEmail,
          fromName: sender.fromName ?? "Claros",
          subject,
          bodyHtml: html,
          bodyText: text,
          // Transactional: no List-Unsubscribe headers.
          headers: {},
          tags: { claros_tenant: p.id, claros_mail: "approvals_digest" },
          messageId: crypto.randomUUID(),
        });
        if (r.success) delivered = true;
        else console.error(`[approvals-digest] mail to an owner of ${p.slug} failed: ${r.error ?? "unknown error"}`);
      } catch (err) {
        console.error(`[approvals-digest] mail to an owner of ${p.slug} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (delivered) result.sent.push(p.id);
  }
  return result;
}
