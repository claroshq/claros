/**
 * Flow editor model: pure helpers for triggers, conditions and plan steps
 * (no React). The shapes mirror the config document (docs/guide/CONFIG.md,
 * docs/guide/FLOWS.md); the server validates them again on save.
 */

export type Json = Record<string, unknown>;
export type Condition = Json;

export const LIFECYCLE_STATES = [
  "signed_up",
  "activated",
  "engaged",
  "at_risk",
  "dormant",
  "churned",
  "resurrected",
] as const;

export const ENGAGEMENT_DEPTHS = ["power", "regular", "casual", "minimal"] as const;

export const TRAIT_OPS = ["eq", "neq", "in", "exists", "not_exists", "gt", "lt"] as const;
export const HISTORY_OPS = ["none", "any", "count_lt"] as const;

export type TriggerType = "lifecycle_transition" | "event" | "segment" | "manual" | "date_property" | "date_schedule";
export type FlowClass = "nurture" | "critical" | "scheduled";

export const FLOW_CLASS_OPTIONS: ReadonlyArray<{ value: FlowClass; label: string; hint: string }> = [
  { value: "nurture", label: "Nurture", hint: "One nurture flow per contact at a time; throttled and inside the send window." },
  { value: "scheduled", label: "Scheduled", hint: "Runs alongside other flows (long date schedules); still throttled and inside the send window." },
  { value: "critical", label: "Critical", hint: "Runs alongside other flows and bypasses frequency caps (billing, security)." },
];

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/** Where a condition is used: which leaf shapes are allowed there. */
export type ConditionScope = "contact" | "step" | "exit";

export type ConditionKind =
  | "all"
  | "any"
  | "not"
  | "trait"
  | "history"
  | "first_contact"
  | "lifecycle_state"
  | "lifecycle_state_not"
  | "event_since_step"
  | "date_unchanged"
  | "event"
  | "lifecycle_state_change";

export const MAX_CONDITION_DEPTH = 4;

/** Leaf and combinator kinds offered in a scope. */
export function kindsFor(scope: ConditionScope): ConditionKind[] {
  const base: ConditionKind[] = ["trait", "history", "first_contact", "lifecycle_state", "lifecycle_state_not", "all", "any", "not"];
  if (scope === "step") return [...base, "event_since_step", "date_unchanged"];
  if (scope === "exit") return [...base, "event", "lifecycle_state_change"];
  return base;
}

export const KIND_LABELS: Record<ConditionKind, string> = {
  all: "All of",
  any: "Any of",
  not: "Not",
  trait: "Trait",
  history: "Send history",
  first_contact: "First contact",
  lifecycle_state: "Lifecycle state is",
  lifecycle_state_not: "Lifecycle state is not",
  event_since_step: "Event since previous step",
  date_unchanged: "Date unchanged",
  event: "Event received",
  lifecycle_state_change: "Becomes lifecycle state",
};

/** The kind of a condition value, or null when it is not a known shape. */
export function conditionKind(c: unknown): ConditionKind | null {
  if (c === null || typeof c !== "object" || Array.isArray(c)) return null;
  const keys = Object.keys(c);
  if (keys.length === 1) {
    const k = keys[0] as ConditionKind;
    if (k in KIND_LABELS) return k;
  }
  return null;
}

/** A fresh condition of a kind, with empty fields to fill in. */
export function emptyCondition(kind: ConditionKind): Condition {
  switch (kind) {
    case "all":
    case "any":
      return { [kind]: [] };
    case "not":
      return { not: { trait: { key: "", op: "eq", value: "" } } };
    case "trait":
      return { trait: { key: "", op: "eq", value: "" } };
    case "history":
      return { history: { op: "none" } };
    case "first_contact":
      return { first_contact: true };
    case "lifecycle_state":
    case "lifecycle_state_not":
      return { [kind]: "engaged" };
    case "event_since_step":
    case "event":
      return { [kind]: "" };
    case "date_unchanged":
      return { date_unchanged: true };
    case "lifecycle_state_change":
      return { lifecycle_state_change: { to: "churned" } };
  }
}

/** A condition field's value as a list: a list stays, one condition becomes [it], absent is []. */
export function toConditionList(v: unknown): Condition[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.filter((x): x is Condition => x !== null && typeof x === "object");
  if (typeof v === "object") return [v as Condition];
  return [];
}

/** Back to a field value: [] is absent, one entry is the condition itself, more stay a list (all). */
export function fromConditionList(list: Condition[]): Condition | Condition[] | undefined {
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return list;
}

function fmt(v: unknown): string {
  if (Array.isArray(v)) return v.map(fmt).join(", ");
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

const OP_TEXT: Record<string, string> = {
  eq: "is",
  neq: "is not",
  in: "is one of",
  gt: "is greater than",
  lt: "is less than",
};

/** One-line, human-readable summary of a condition (or a list: all of them). */
export function summarizeCondition(c: unknown): string {
  if (Array.isArray(c)) {
    if (c.length === 0) return "always";
    return c.length === 1 ? summarizeCondition(c[0]) : c.map((x) => `(${summarizeCondition(x)})`).join(" and ");
  }
  const kind = conditionKind(c);
  if (!kind) return JSON.stringify(c);
  const v = (c as Json)[kind];
  switch (kind) {
    case "all":
    case "any": {
      const items = Array.isArray(v) ? v : [];
      if (items.length === 0) return kind === "all" ? "always" : "never";
      return items.map((x) => `(${summarizeCondition(x)})`).join(kind === "all" ? " and " : " or ");
    }
    case "not":
      return `not (${summarizeCondition(v)})`;
    case "trait": {
      const t = (v ?? {}) as Json;
      const key = String(t.key ?? "");
      if (t.op === "exists") return `${key} is set`;
      if (t.op === "not_exists") return `${key} is not set`;
      return `${key} ${OP_TEXT[String(t.op)] ?? String(t.op)} ${fmt(t.value)}`;
    }
    case "history": {
      const h = (v ?? {}) as Json;
      const what = h.flow ? `flow ${fmt(h.flow)}` : h.action_type ? `action ${fmt(h.action_type)}` : h.topic ? `topic ${fmt(h.topic)}` : "anything";
      const when = h.within ? ` in the last ${fmt(h.within)}` : "";
      if (h.op === "any") return `was sent ${what}${when}`;
      if (h.op === "count_lt") return `was sent ${what} fewer than ${fmt(h.value)} times${when}`;
      return `was never sent ${what}${when}`;
    }
    case "first_contact":
      return v === false ? "has received mail before" : "has never received mail";
    case "lifecycle_state":
      return `lifecycle state is ${fmt(v)}`;
    case "lifecycle_state_not":
      return `lifecycle state is not ${fmt(v)}`;
    case "event_since_step":
      return `${fmt(v)} happened since the previous step`;
    case "date_unchanged":
      return "the date is unchanged";
    case "event":
      return `${fmt(v)} occurs`;
    case "lifecycle_state_change":
      return `becomes ${fmt((v as Json | undefined)?.to)}`;
  }
}

/** Problems a person can fix before saving (empty keys, missing values, too deep). */
export function conditionProblems(c: unknown, depth = 1): string[] {
  if (depth > MAX_CONDITION_DEPTH) return [`conditions nest at most ${MAX_CONDITION_DEPTH} levels`];
  const kind = conditionKind(c);
  if (!kind) return [`unknown condition ${JSON.stringify(c)}`];
  const v = (c as Json)[kind];
  switch (kind) {
    case "all":
    case "any":
      return (Array.isArray(v) ? v : []).flatMap((x) => conditionProblems(x, depth + 1));
    case "not":
      return conditionProblems(v, depth + 1);
    case "trait": {
      const t = (v ?? {}) as Json;
      const out: string[] = [];
      if (typeof t.key !== "string" || t.key.trim() === "") out.push("a trait condition needs a key");
      if (t.op === "in" && !Array.isArray(t.value)) out.push("'is one of' needs a list");
      if (["eq", "neq", "gt", "lt"].includes(String(t.op)) && (t.value === undefined || t.value === "")) out.push(`trait ${String(t.key ?? "")}: a value is needed`);
      return out;
    }
    case "history": {
      const h = (v ?? {}) as Json;
      if (h.op === "count_lt" && typeof h.value !== "number") return ["'fewer than' needs a number"];
      if (h.within !== undefined && !/^\d+(m|h|d)$/.test(String(h.within))) return ["within must look like 7d, 12h or 30m"];
      return [];
    }
    case "event_since_step":
    case "event":
      return typeof v === "string" && v.trim() !== "" ? [] : ["an event condition needs an event name"];
    default:
      return [];
  }
}

/**
 * Parse a trait value typed in a text box: numbers and true/false become
 * JSON values, a list for 'in' is comma separated, anything else is text.
 */
export function parseTraitValue(raw: string, op: string): unknown {
  if (op === "in") return raw.split(",").map((s) => parseScalar(s.trim())).filter((s) => s !== "");
  return parseScalar(raw);
}

function parseScalar(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== "" && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/** The text shown for a trait value. */
export function formatTraitValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  return String(v);
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export interface TriggerDraft {
  type: TriggerType;
  config: Json;
}

const DURATION = /^\d+(m|h|d)$/;
const SIGNED_DURATION = /^[+-]?\d+(m|h|d)$/;
const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Events of an event trigger (one or several). */
export function triggerEvents(config: Json): string[] {
  const e = config.event;
  if (Array.isArray(e)) return e.filter((x): x is string => typeof x === "string");
  return typeof e === "string" && e !== "" ? [e] : [];
}

/** Whether a segment trigger targets lifecycle states (else a grid cell). */
export function segmentByState(config: Json): boolean {
  return Array.isArray(config.lifecycle_states);
}

/** Problems with a trigger draft; empty when it can be saved. */
export function triggerProblems(d: TriggerDraft): string[] {
  const c = d.config;
  const out: string[] = [];
  switch (d.type) {
    case "lifecycle_transition":
      if (!c.to) out.push("Pick the state the contact moves to.");
      break;
    case "event":
      if (triggerEvents(c).length === 0) out.push("Name at least one event.");
      break;
    case "segment":
      if (segmentByState(c)) {
        if ((c.lifecycle_states as unknown[]).length === 0) out.push("Pick at least one lifecycle state.");
      } else if (!c.tenure_bucket || !c.recency_bucket) out.push("Pick a tenure and a recency.");
      break;
    case "manual":
      break;
    case "date_property":
      if (!c.property) out.push("Name the date trait.");
      if (typeof c.offset !== "string" || !SIGNED_DURATION.test(c.offset)) out.push("The offset looks like -3d, 0d or 2h.");
      break;
    case "date_schedule": {
      if (!c.anchor) out.push("Name the anchor date trait.");
      const offsets = Array.isArray(c.offsets) ? (c.offsets as unknown[]) : [];
      if (offsets.length === 0 || offsets.some((o) => typeof o !== "string" || !DURATION.test(o))) out.push("Offsets look like 1d, 3d, 7d.");
      if (c.repeat !== undefined && (typeof c.repeat !== "string" || !DURATION.test(c.repeat))) out.push("Repeat looks like 30d.");
      if (typeof c.max_sends !== "number" || c.max_sends < 1) out.push("Set the maximum number of sends.");
      break;
    }
  }
  if ((d.type === "date_property" || d.type === "date_schedule") && c.send_at_local !== undefined && !LOCAL_TIME.test(String(c.send_at_local))) {
    out.push("Send time looks like 09:00.");
  }
  for (const cond of toConditionList(c.where)) out.push(...conditionProblems(cond));
  return out;
}

/** The trigger_config to send: empty fields dropped, a single event stays a string. */
export function cleanTriggerConfig(d: TriggerDraft): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(d.config)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0 && k !== "lifecycle_states") continue;
    out[k] = v;
  }
  if (d.type === "event") {
    const events = triggerEvents(d.config);
    if (events.length === 1) out.event = events[0];
    else if (events.length > 1) out.event = events;
  }
  if (d.type === "segment") {
    if (segmentByState(d.config)) {
      delete out.tenure_bucket;
      delete out.recency_bucket;
    } else {
      delete out.lifecycle_states;
      delete out.engagement_depths;
    }
  }
  const where = toConditionList(d.config.where);
  if (where.length === 0) delete out.where;
  else out.where = where.length === 1 ? where[0] : where;
  return out;
}

/** One-line summary of a trigger. */
export function summarizeTrigger(type: string, config: Json): string {
  const where = toConditionList(config.where);
  const tail = where.length > 0 ? `, if ${summarizeCondition(where)}` : "";
  switch (type) {
    case "lifecycle_transition":
      return `A contact moves ${config.from ? `from ${fmt(config.from)} ` : ""}to ${fmt(config.to)}${tail}`;
    case "event": {
      const events = triggerEvents(config);
      return `${events.length > 1 ? "One of the events" : "The event"} ${events.join(", ")} is received${tail}`;
    }
    case "segment":
      if (segmentByState(config)) {
        const depths = Array.isArray(config.engagement_depths) && config.engagement_depths.length > 0 ? ` with engagement ${fmt(config.engagement_depths)}` : "";
        return `A contact is ${fmt(config.lifecycle_states)}${depths}${tail}`;
      }
      return `A contact is in the ${fmt(config.tenure_bucket)} / ${fmt(config.recency_bucket)} retention cell${tail}`;
    case "manual":
      return `Contacts are enrolled by hand (POST /v1/flows/:id/enroll)${tail}`;
    case "date_property":
      return `The date trait ${fmt(config.property)} is ${fmt(config.offset)} away${config.send_at_local ? `, at ${fmt(config.send_at_local)} local time` : ""}${tail}`;
    case "date_schedule":
      return `Scheduled from ${fmt(config.anchor)} at ${fmt(config.offsets)}${config.repeat ? `, then every ${fmt(config.repeat)}` : ""}, up to ${fmt(config.max_sends)} sends${config.send_at_local ? `, at ${fmt(config.send_at_local)} local time` : ""}${tail}`;
    default:
      return type;
  }
}

/** A sensible empty config when the trigger type changes. */
export function defaultTriggerConfig(type: TriggerType): Json {
  switch (type) {
    case "event":
      return { event: "" };
    case "segment":
      return { tenure_bucket: "", recency_bucket: "" };
    case "date_property":
      return { property: "", offset: "-3d" };
    case "date_schedule":
      return { anchor: "", offsets: ["1d", "3d", "7d"], max_sends: 3 };
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Step keys in the order the editor writes them. */
const STEP_KEY_ORDER = [
  "order", "action_type", "type", "delay", "window_policy", "template_ref", "kb_ref", "brain_instruction",
  "from_name", "reply_to", "eyebrow", "preheader", "allowed_links", "single_cta",
  "condition", "exit_condition", "expires_after", "context", "on_empty", "on_error", "kb_select",
  "candidates", "allow_none",
];

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

function cleanObject(o: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(o)) {
    if (isEmpty(v)) continue;
    out[k] = v;
  }
  return out;
}

/** A step ready to save: empty fields dropped, conditions normalised, keys ordered. */
export function cleanStep(step: Json): Json {
  const s: Json = { ...step };
  for (const k of ["condition", "exit_condition"]) s[k] = fromConditionList(toConditionList(s[k]));
  if (s.single_cta === false) delete s.single_cta;
  if (s.type === "send") delete s.type;
  if (s.type !== "choose") {
    delete s.candidates;
    delete s.allow_none;
  } else if (Array.isArray(s.candidates)) {
    s.candidates = (s.candidates as Json[]).map((c) => {
      const cc = cleanObject({ ...c, when: toConditionList(c.when) });
      if (cc.kb_select) cc.kb_select = cleanObject(cc.kb_select as Json);
      if (Array.isArray(cc.context)) cc.context = (cc.context as Json[]).map(cleanObject);
      return cc;
    });
  }
  if (s.kb_select && typeof s.kb_select === "object") s.kb_select = cleanObject(s.kb_select as Json);
  if (Array.isArray(s.context)) s.context = (s.context as Json[]).map(cleanObject).filter((c) => !isEmpty(c));
  const cleaned = cleanObject(s);
  if (step.allow_none === false && s.type === "choose") cleaned.allow_none = false;
  const ordered: Json = {};
  for (const k of STEP_KEY_ORDER) if (k in cleaned) ordered[k] = cleaned[k];
  for (const k of Object.keys(cleaned)) if (!(k in ordered)) ordered[k] = cleaned[k];
  return ordered;
}

/** Problems a person can fix before saving a step list. */
export function stepProblems(steps: Json[]): string[] {
  const out: string[] = [];
  const orders = new Set<number>();
  for (const s of steps) {
    const at = `Step ${String(s.order ?? "?")}`;
    if (typeof s.order !== "number" || s.order < 1) out.push(`${at}: order is a whole number from 1.`);
    else if (orders.has(s.order)) out.push(`${at}: the order is used twice.`);
    else orders.add(s.order);
    if (typeof s.action_type !== "string" || s.action_type.trim() === "") out.push(`${at}: name the action type.`);
    if (typeof s.delay !== "string" || !DURATION.test(s.delay)) out.push(`${at}: delay looks like 0m, 2h or 3d.`);
    if (s.expires_after !== undefined && s.expires_after !== "" && !DURATION.test(String(s.expires_after))) out.push(`${at}: expires after looks like 2d.`);
    if (s.type === "choose" && (!Array.isArray(s.candidates) || s.candidates.length === 0)) out.push(`${at}: a choose step needs candidates.`);
    if (typeof s.reply_to === "string" && s.reply_to !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.reply_to)) out.push(`${at}: reply-to is an email address.`);
    for (const k of ["condition", "exit_condition"]) for (const c of toConditionList(s[k])) out.push(...conditionProblems(c).map((p) => `${at}: ${p}`));
    if (Array.isArray(s.candidates)) {
      const types = new Set<string>();
      for (const c of s.candidates as Json[]) {
        if (typeof c.action_type !== "string" || c.action_type === "") out.push(`${at}: every candidate needs an action type.`);
        else if (types.has(c.action_type)) out.push(`${at}: candidate ${c.action_type} is listed twice.`);
        else types.add(c.action_type);
        for (const w of toConditionList(c.when)) out.push(...conditionProblems(w).map((p) => `${at}: ${p}`));
      }
    }
  }
  return out;
}

/** The next free step order. */
export function nextOrder(steps: Json[]): number {
  return steps.reduce((m, s) => (typeof s.order === "number" && s.order > m ? s.order : m), 0) + 1;
}
