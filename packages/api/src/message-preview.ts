/**
 * Renders a message the way the recipient's mail client shows it: the stored
 * body inside the product's email template (brand, eyebrow, preheader,
 * footer), assembled the same way as the drain does at send time
 * (packages/worker/src/drain.ts, step 8).
 *
 * Used by the Approvals queue (what will go out) and the Sent Mail detail
 * (what went out). Differences from the delivered mail:
 * - the unsubscribe link is a placeholder; the real one is signed per message;
 * - the email template and the product's brand are their current versions,
 *   which may have changed since the message was sent.
 * With `tagLinks`, link tracking (UTM parameters and click id) is applied to
 * the body as the drain does; the Approvals preview leaves links untagged.
 */
import { storeFor } from "@claros/store";
import {
  wrapInShell,
  resolveMessageLayout,
  buildShellComplianceHtml,
  stepPresentation,
  resolveLinkTracking,
  tagHtmlLinks,
  type BrandSettings,
} from "@claros/core";
import type { Db } from "./plugins/db.js";
import { loadCustomLayout } from "./routes/layouts.js";

export interface PreviewableMessage {
  id: string;
  flow_id: string;
  flow_step_order: number | null;
  brain_action_type: string | null;
  body_html: string | null;
}

export interface MessagePreview {
  html: string;
  /** The inbox preview line the step sets, when it sets one. */
  preheader: string | null;
}

/** Previews keyed by message id. Messages without an HTML body are left out. */
export async function renderMessagePreviews(
  db: Db,
  tenantId: string,
  rows: PreviewableMessage[],
  opts: { tagLinks?: boolean } = {},
): Promise<Map<string, MessagePreview>> {
  const out = new Map<string, MessagePreview>();
  if (!rows.some((r) => r.body_html)) return out;
  const tenant = await storeFor(db).workerDrain.getTenant(tenantId);
  const settings = (tenant?.settings as Record<string, unknown> | null) ?? {};
  const brand = (settings.brand as BrandSettings | undefined) ?? {};
  const addr = typeof settings.postal_address === "string" ? settings.postal_address.trim() : "";
  const footer = buildShellComplianceHtml(
    "#",
    addr || "No postal address set. Mail is held until one is set in Settings.",
    tenant?.locale ?? null,
  );
  const tracking = opts.tagLinks ? resolveLinkTracking(settings) : null;
  const plans = new Map<string, unknown>();
  const labels = new Map<string, { slug: string | null; name: string } | null>();
  const shells = new Map<string, Awaited<ReturnType<typeof resolveMessageLayout<BrandSettings>>>>();
  const load = (id: string) => loadCustomLayout(db, tenantId, id);
  for (const flowId of new Set(rows.filter((r) => r.body_html).map((r) => r.flow_id))) {
    const flow = await storeFor(db).apiFlows.findFlow({ tenantId, id: flowId });
    plans.set(flowId, flow?.compiledPlan ?? null);
    shells.set(flowId, await resolveMessageLayout(brand, flow?.emailTemplate, load));
    if (tracking) labels.set(flowId, await storeFor(db).workerDrain.getFlowLabel(flowId));
  }
  for (const r of rows) {
    if (!r.body_html) continue;
    const presentation = stepPresentation(plans.get(r.flow_id) ?? null, r.flow_step_order, r.brain_action_type);
    let bodyHtml = r.body_html;
    if (tracking) {
      const label = labels.get(r.flow_id) ?? null;
      bodyHtml = tagHtmlLinks(bodyHtml, tracking, {
        messageId: r.id,
        flowSlug: label?.slug ?? null,
        flowName: label?.name ?? null,
        stepOrder: r.flow_step_order,
        actionType: null,
      });
    }
    out.set(r.id, {
      html: wrapInShell({
        bodyHtml,
        brand: shells.get(r.flow_id)?.brand ?? brand,
        tenantName: tenant?.name ?? "Our Team",
        complianceFooterHtml: footer,
        eyebrow: presentation.eyebrow,
        preheader: presentation.preheader,
        layout: shells.get(r.flow_id)?.layout ?? null,
      }),
      preheader: presentation.preheader ?? null,
    });
  }
  return out;
}
