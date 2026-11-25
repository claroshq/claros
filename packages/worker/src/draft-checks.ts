/**
 * Post-draft checks (G19), applied to AI drafts after drafting and before the
 * value gate (assess):
 *
 *   1. settings.brain.text_rules objects: {find, replace} rewrites the subject
 *      and body (find is a literal string, or /pattern/flags for a regular
 *      expression); {forbid} blocks the draft when the text appears
 *      (case-insensitive). String rules are writing rules for the model only.
 *   2. Link allowlist (on once the product declares settings.links or
 *      link_tracking.domains): every http(s) URL in the subject or body must be one of
 *      the product's named links (settings.links; the same URL with extra
 *      query parameters counts), on a link_tracking domain (or a subdomain),
 *      or a URL returned by the step's context sources. Anything else blocks
 *      the draft: the message fails with status_reason 'link_not_allowed' and
 *      the draft stays visible in approvals.
 */
export type TextRule = string | { find: string; replace: string } | { forbid: string };

/** The object rules of settings.brain.text_rules. */
export function textRuleObjects(settings: Record<string, unknown> | null | undefined): Array<Exclude<TextRule, string>> {
  const rules = (settings?.brain as { text_rules?: unknown } | undefined)?.text_rules;
  if (!Array.isArray(rules)) return [];
  return rules.filter((r): r is Exclude<TextRule, string> => !!r && typeof r === "object" && ("forbid" in r || "find" in r));
}

/** The string rules of settings.brain.text_rules (given to the drafting model). */
export function textRuleStrings(settings: Record<string, unknown> | null | undefined): string[] {
  const rules = (settings?.brain as { text_rules?: unknown } | undefined)?.text_rules;
  return Array.isArray(rules) ? rules.filter((r): r is string => typeof r === "string") : [];
}

function toRegex(find: string): RegExp | null {
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(find);
  if (!m) return null;
  try {
    return new RegExp(m[1]!, m[2]!.includes("g") ? m[2]! : `${m[2]}g`);
  } catch {
    return null;
  }
}

export function applyTextRules(
  rules: ReadonlyArray<Exclude<TextRule, string>>,
  draft: { subject: string; body: string },
): { subject: string; body: string; forbidden: string[] } {
  let { subject, body } = draft;
  const forbidden: string[] = [];
  for (const r of rules) {
    if ("find" in r) {
      const re = toRegex(r.find);
      if (re) {
        subject = subject.replace(re, r.replace);
        body = body.replace(re, r.replace);
      } else {
        subject = subject.split(r.find).join(r.replace);
        body = body.split(r.find).join(r.replace);
      }
    }
  }
  for (const r of rules) {
    if ("forbid" in r) {
      const re = toRegex(r.forbid);
      const hit = re ? re.test(subject) || (re.lastIndex = 0, re.test(body)) : `${subject}\n${body}`.toLowerCase().includes(r.forbid.toLowerCase());
      if (hit) forbidden.push(r.forbid);
    }
  }
  return { subject, body, forbidden };
}

const URL_RE = /https?:\/\/[^\s<>"'()\]]+/gi;

/** Every http(s) URL in a text, trailing punctuation removed. */
export function extractUrls(text: string): string[] {
  return (text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?*_]+$/, ""));
}

function urlsIn(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    for (const u of extractUrls(value)) out.add(u);
  } else if (Array.isArray(value)) {
    for (const v of value) urlsIn(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) urlsIn(v, out);
  }
}

function sameLink(url: string, allowed: string): boolean {
  const a = url.replace(/\/$/, "");
  const b = allowed.replace(/\/$/, "");
  if (a === b) return true;
  return url.startsWith(`${b}?`) || url.startsWith(`${b}#`) || url.startsWith(`${allowed}?`) || url.startsWith(`${allowed}#`);
}

/** URLs of a draft that are not allowed (see the module header). */
export function findDisallowedLinks(
  text: string,
  allow: { links: Record<string, string>; trackedDomains: readonly string[]; context?: Record<string, unknown> | null },
): string[] {
  const fromContext = new Set<string>();
  if (allow.context) urlsIn(allow.context, fromContext);
  const links = Object.values(allow.links);
  const domains = allow.trackedDomains.map((d) => d.toLowerCase());
  const bad: string[] = [];
  for (const u of extractUrls(text)) {
    if (links.some((l) => sameLink(u, l))) continue;
    if ([...fromContext].some((c) => sameLink(u, c))) continue;
    let host = "";
    try {
      host = new URL(u).hostname.toLowerCase();
    } catch {
      bad.push(u);
      continue;
    }
    if (domains.some((d) => host === d || host.endsWith(`.${d}`))) continue;
    if (!bad.includes(u)) bad.push(u);
  }
  return bad;
}

/** link_tracking.domains of the product settings. */
export function trackedDomains(settings: Record<string, unknown> | null | undefined): string[] {
  const lt = settings?.link_tracking as { domains?: unknown } | null | undefined;
  return Array.isArray(lt?.domains) ? lt!.domains.filter((d): d is string => typeof d === "string") : [];
}
