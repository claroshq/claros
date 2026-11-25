/**
 * UTM tagging of links (G6). Pure; applied by the drain to the message body
 * right before the shell and compliance footer are added, so unsubscribe
 * and footer links are never tagged.
 *
 * Product setting `link_tracking`:
 *   {
 *     domains: ["fundup.ai"],            // host or any subdomain of it
 *     params: { utm_source: "claros", utm_medium: "email",
 *               utm_campaign: "{{flow.slug}}", utm_content: "step-{{step.order}}" },
 *     click_id: true                     // adds clr_cid=<message id>
 *   }
 *
 * Placeholders: {{flow.slug}} (the flow name when it has no slug),
 * {{flow.name}}, {{step.order}}, {{message.id}}, {{action_type}}. A
 * parameter already present in a link is never overwritten; links on other
 * domains, mailto:, relative and malformed links are left as they are.
 */
import { z } from "zod";

export const linkTrackingSchema = z
  .object({
    domains: z.array(z.string().min(1).max(253)).max(50),
    params: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), z.string().max(200)).default({}),
    click_id: z.boolean().default(false),
  })
  .strict();

export type LinkTracking = z.infer<typeof linkTrackingSchema>;

export interface LinkTagContext {
  messageId: string;
  flowSlug: string | null;
  flowName: string | null;
  stepOrder: number | null;
  actionType: string | null;
}

/** Name of the click id parameter. */
export const CLICK_ID_PARAM = "clr_cid";

function hostMatches(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return domains.some((d) => {
    const dom = d.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    return h === dom || h.endsWith(`.${dom}`);
  });
}

function fill(template: string, ctx: LinkTagContext): string {
  return template
    .replace(/\{\{\s*flow\.slug\s*\}\}/g, ctx.flowSlug ?? ctx.flowName ?? "")
    .replace(/\{\{\s*flow\.name\s*\}\}/g, ctx.flowName ?? "")
    .replace(/\{\{\s*step\.order\s*\}\}/g, ctx.stepOrder === null ? "" : String(ctx.stepOrder))
    .replace(/\{\{\s*message\.id\s*\}\}/g, ctx.messageId)
    .replace(/\{\{\s*action_type\s*\}\}/g, ctx.actionType ?? "");
}

/** Tag one absolute URL, or return it unchanged. */
export function tagUrl(raw: string, tracking: LinkTracking, ctx: LinkTagContext): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return raw;
  if (!hostMatches(url.hostname, tracking.domains)) return raw;
  let changed = false;
  for (const [key, template] of Object.entries(tracking.params ?? {})) {
    if (url.searchParams.has(key)) continue;
    const value = fill(template, ctx);
    if (value === "") continue;
    url.searchParams.set(key, value);
    changed = true;
  }
  if (tracking.click_id && !url.searchParams.has(CLICK_ID_PARAM)) {
    url.searchParams.set(CLICK_ID_PARAM, ctx.messageId);
    changed = true;
  }
  return changed ? url.toString() : raw;
}

const HREF_RE = /(<a\b[^>]*?\bhref\s*=\s*)(["'])([^"']*)\2/gi;

/** Tag the href of every <a> in an HTML fragment. Entities in hrefs (&amp;) are kept. */
export function tagHtmlLinks(html: string, tracking: LinkTracking | null | undefined, ctx: LinkTagContext): string {
  if (!tracking || tracking.domains.length === 0) return html;
  return html.replace(HREF_RE, (whole, prefix: string, quote: string, href: string) => {
    const decoded = href.replace(/&amp;/g, "&");
    const tagged = tagUrl(decoded, tracking, ctx);
    if (tagged === decoded) return whole;
    return `${prefix}${quote}${tagged.replace(/&/g, "&amp;")}${quote}`;
  });
}

const TEXT_URL_RE = /https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g;

/** Tag bare URLs in a plain-text body. */
export function tagTextLinks(text: string, tracking: LinkTracking | null | undefined, ctx: LinkTagContext): string {
  if (!tracking || tracking.domains.length === 0) return text;
  return text.replace(TEXT_URL_RE, (url) => tagUrl(url, tracking, ctx));
}

/** The product's link_tracking setting when valid, else null. */
export function resolveLinkTracking(settings: Record<string, unknown> | null | undefined): LinkTracking | null {
  const parsed = linkTrackingSchema.safeParse(settings?.link_tracking);
  return parsed.success && parsed.data.domains.length > 0 ? parsed.data : null;
}
