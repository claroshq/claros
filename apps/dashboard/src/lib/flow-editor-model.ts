/**
 * Flow editor draft model (pure, no React).
 *
 * The editor keeps one draft of everything on the page: name, trigger,
 * delivery settings, the plan's steps and exits, and the fixed copy of the
 * steps that use a template. Saving writes the differences: PATCH the flow,
 * PUT each changed template by slug, PUT the steps. The steps keep the
 * config document shape (docs/guide/FLOWS.md), so a plan written in a config
 * file round-trips through the editor unchanged.
 */
import type { Flow, StepCopy } from "../api.js";
import {
  cleanStep,
  conditionProblems,
  nextOrder,
  stepProblems,
  summarizeCondition,
  summarizeTrigger,
  toConditionList,
  triggerProblems,
  type Condition,
  type Json,
  type TriggerDraft,
  type TriggerType,
} from "./flow-model.js";

export interface FlowSettingsDraft {
  approval_mode: Flow["approval_mode"];
  topic_id: string | null;
  flow_class: Flow["flow_class"];
  priority: number;
  reentry_policy: Flow["reentry_policy"];
  reentry_cooldown_days: number;
}

export interface EditorDraft extends FlowSettingsDraft {
  name: string;
  trigger: TriggerDraft;
  /** Prompt of a prompt-defined flow; null when the flow has none. */
  prompt: string | null;
  steps: Json[];
  exits: Condition[];
  /** Fixed copy edited in this draft, by template slug (unedited copy is read from the templates). */
  copies: Record<string, StepCopy>;
}

export type StepMode = "fixed" | "ai" | "choose";

/** Keys the editor keeps on a step while editing; never saved. */
const STASH_PREFIX = "__";

// ---------------------------------------------------------------------------
// Building drafts
// ---------------------------------------------------------------------------

export function defaultSettings(): FlowSettingsDraft {
  return { approval_mode: "require", topic_id: null, flow_class: "nurture", priority: 0, reentry_policy: "once", reentry_cooldown_days: 30 };
}

export function emptyDraft(trigger: TriggerDraft = { type: "event", config: { event: "" } }): EditorDraft {
  return { name: "", trigger, prompt: null, steps: [], exits: [], copies: {}, ...defaultSettings() };
}

/** The plan steps a flow has now (compiled plan first, then the steps column). */
export function flowSteps(flow: Pick<Flow, "compiled_plan" | "steps">): Json[] {
  const plan = flow.compiled_plan;
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : Array.isArray(flow.steps) ? flow.steps : [];
  return (steps as Json[]).map((s) => ({ ...s }));
}

export function draftFromFlow(flow: Flow): EditorDraft {
  const plan = flow.compiled_plan;
  return {
    name: flow.name,
    trigger: { type: flow.trigger_type as TriggerType, config: { ...((flow.trigger_config ?? {}) as Json) } },
    prompt: flow.prompt_source && flow.prompt_source.trim() !== "" ? flow.prompt_source : null,
    steps: sortSteps(flowSteps(flow)),
    exits: plan ? toConditionList(plan.exit_conditions) : [],
    copies: {},
    approval_mode: flow.approval_mode,
    topic_id: flow.topic_id ?? null,
    flow_class: flow.flow_class,
    priority: flow.priority ?? 0,
    reentry_policy: flow.reentry_policy,
    reentry_cooldown_days: flow.reentry_cooldown_days ?? 30,
  };
}

export function sortSteps(steps: Json[]): Json[] {
  return [...steps].sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export function stepMode(step: Json): StepMode {
  if (step.type === "choose") return "choose";
  return typeof step.template_ref === "string" && step.template_ref !== "" ? "fixed" : "ai";
}

/** A fresh template slug for a step's copy (config slug rules: a-z, 0-9, _ and -). */
export function newCopySlug(random: () => string = () => Math.random().toString(36).slice(2, 8)): string {
  return `flow-copy-${random()}`.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

/** A new step after the existing ones: fixed copy by default, one day after the previous email. */
export function newStep(steps: Json[], mode: "fixed" | "ai", slug: string): Json {
  const order = nextOrder(steps);
  const base: Json = { order, action_type: `email_${order}`, delay: steps.length === 0 ? "0m" : "1d", window_policy: "respect_window" };
  return mode === "fixed" ? { ...base, template_ref: slug } : { ...base, brain_instruction: "" };
}

/**
 * Switch who writes a step. The other mode's field is kept aside on the
 * step (never saved) so switching back restores it.
 */
export function switchStepMode(step: Json, mode: "fixed" | "ai", slug: string): Json {
  const current = stepMode(step);
  if (current === mode) return step;
  const s: Json = { ...step };
  if (mode === "fixed") {
    if (typeof s.brain_instruction === "string") s[`${STASH_PREFIX}brain_instruction`] = s.brain_instruction;
    delete s.brain_instruction;
    delete s.type;
    delete s.candidates;
    delete s.allow_none;
    s.template_ref = typeof s[`${STASH_PREFIX}template_ref`] === "string" ? s[`${STASH_PREFIX}template_ref`] : slug;
  } else {
    if (typeof s.template_ref === "string") s[`${STASH_PREFIX}template_ref`] = s.template_ref;
    delete s.template_ref;
    s.brain_instruction = typeof s[`${STASH_PREFIX}brain_instruction`] === "string" ? s[`${STASH_PREFIX}brain_instruction`] : "";
  }
  return s;
}

/** Swap a step's position with its neighbour; orders move with the positions. */
export function moveStep(steps: Json[], index: number, dir: -1 | 1): Json[] {
  const j = index + dir;
  if (j < 0 || j >= steps.length) return steps;
  const next = steps.map((s) => ({ ...s }));
  const a = next[index]!;
  const b = next[j]!;
  const ao = a.order;
  a.order = b.order;
  b.order = ao;
  next[index] = b;
  next[j] = a;
  return next;
}

/** A step as saved: editor-only keys dropped, then the shared cleaner. */
export function saveableStep(step: Json): Json {
  const s: Json = {};
  for (const [k, v] of Object.entries(step)) if (!k.startsWith(STASH_PREFIX)) s[k] = v;
  return cleanStep(s);
}

export function planBody(draft: Pick<EditorDraft, "steps" | "exits">): { steps: Json[]; exit_conditions?: Condition[] } {
  const steps = draft.steps.map(saveableStep);
  return draft.exits.length > 0 ? { steps, exit_conditions: draft.exits } : { steps };
}

// ---------------------------------------------------------------------------
// Delays
// ---------------------------------------------------------------------------

export type DelayUnit = "m" | "h" | "d";

export function parseDelay(delay: unknown): { n: number; unit: DelayUnit } {
  const m = typeof delay === "string" ? /^(\d+)([mhd])$/.exec(delay) : null;
  if (!m) return { n: 0, unit: "d" };
  return { n: Number(m[1]), unit: m[2] as DelayUnit };
}

export function formatDelay(n: number, unit: DelayUnit): string {
  return `${Math.max(0, Math.floor(Number.isFinite(n) ? n : 0))}${unit}`;
}

const UNIT_WORD: Record<DelayUnit, [string, string]> = { m: ["minute", "minutes"], h: ["hour", "hours"], d: ["day", "days"] };

/** "right away", "1 day later", "3 hours later". */
export function describeDelay(delay: unknown): string {
  const { n, unit } = parseDelay(delay);
  if (n === 0) return "right away";
  return `${n} ${UNIT_WORD[unit][n === 1 ? 0 : 1]} later`;
}

/** Minutes from enrollment to each step (delays add up). */
export function cumulativeMinutes(steps: Json[]): number[] {
  let total = 0;
  return steps.map((s) => {
    const { n, unit } = parseDelay(s.delay);
    total += unit === "m" ? n : unit === "h" ? n * 60 : n * 1440;
    return total;
  });
}

/** "day 0", "day 3", "after 4 hours" for the timeline. */
export function describeOffset(minutes: number): string {
  if (minutes === 0) return "when they enter";
  if (minutes < 1440) {
    const h = Math.round(minutes / 60);
    return h >= 1 ? `${h} hour${h === 1 ? "" : "s"} in` : `${minutes} minutes in`;
  }
  return `day ${Math.round(minutes / 1440)}`;
}

// ---------------------------------------------------------------------------
// Summary and checks
// ---------------------------------------------------------------------------

function lowerFirst(s: string): string {
  return s.length > 0 ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/** One sentence that says what the flow does, for the page header. */
export function summarizeFlow(draft: EditorDraft): string {
  const trigger = lowerFirst(summarizeTrigger(draft.trigger.type, draft.trigger.config));
  const n = draft.steps.length;
  const parts: string[] = [];
  if (n === 0) {
    parts.push(draft.prompt ? `When ${trigger}, the steps come from the prompt once it is compiled.` : `When ${trigger}, nothing is sent yet: add an email.`);
  } else if (draft.trigger.type === "date_schedule") {
    parts.push(`When ${trigger}, send ${n === 1 ? "one email" : `${n} emails`} on the schedule's dates.`);
  } else {
    const mins = cumulativeMinutes(draft.steps);
    const span = mins[mins.length - 1] ?? 0;
    const over = span >= 1440 ? ` over ${Math.round(span / 1440)} day${Math.round(span / 1440) === 1 ? "" : "s"}` : "";
    parts.push(`When ${trigger}, send ${n === 1 ? "one email" : `${n} emails`}${over}.`);
  }
  if (draft.exits.length > 0) parts.push(`Stops early if ${draft.exits.map((e) => summarizeCondition(e)).join(" or ")}.`);
  parts.push(draft.approval_mode === "require" ? "You approve each email before it sends." : "Emails send without review.");
  return parts.join(" ");
}

/** Variables a template may use; anything else fails the render (packages/worker template-renderer). */
const VARIABLE_ROOTS = ["contact.first_name", "contact.last_name", "contact.email", "contact.external_id", "tenant.name", "flow.name", "brain.opening"];
const VARIABLE_PREFIXES = ["contact.properties.", "context.", "links.", "kb.", "event.", "traits."];

/** {{variables}} in a text that the renderer does not know (sections and fallbacks aside). */
export function unknownVariables(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([#^/]?)\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*(\|[^}]*)?\}\}/g)) {
    const path = m[2]!;
    if (m[1] || path === ".") continue;
    if (VARIABLE_ROOTS.includes(path) || VARIABLE_PREFIXES.some((p) => path.startsWith(p) && path.length > p.length)) continue;
    out.add(path);
  }
  return [...out];
}

/** Variables without a fallback: the send fails for a contact who lacks the value. */
export function variablesWithoutFallback(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*(\|[^}]*)?\}\}/g)) {
    if (!m[2] && m[1] !== "tenant.name" && m[1] !== "flow.name" && m[1] !== "contact.email" && m[1] !== "contact.external_id" && !m[1]!.startsWith("links.")) out.add(m[1]!);
  }
  return [...out];
}

export interface DraftProblem {
  /** Index of the step, "trigger", "exits" or "name". */
  where: number | "trigger" | "exits" | "name";
  message: string;
}

/** Everything that blocks saving, attached to where it can be fixed. */
export function draftProblems(draft: EditorDraft, copyOf: (slug: string) => StepCopy | undefined): DraftProblem[] {
  const out: DraftProblem[] = [];
  if (draft.name.trim() === "") out.push({ where: "name", message: "Give the flow a name." });
  for (const m of triggerProblems(draft.trigger)) out.push({ where: "trigger", message: m });
  for (const c of draft.exits) for (const m of conditionProblems(c)) out.push({ where: "exits", message: m });
  draft.steps.forEach((s, i) => {
    const label = `Email ${i + 1}`;
    for (const m of stepProblems([saveableStep(s)])) {
      if (/action type/.test(m)) out.push({ where: i, message: `${label}: give it an internal name (Advanced).` });
      else out.push({ where: i, message: m.replace(/^Step \S+:/, `${label}:`) });
    }
    const mode = stepMode(s);
    if (mode === "fixed") {
      const copy = copyOf(String(s.template_ref));
      if (!copy || copy.subject.trim() === "") out.push({ where: i, message: `${label}: write a subject.` });
      if (!copy || copy.body_html.trim() === "") out.push({ where: i, message: `${label}: write the body.` });
      for (const v of copy ? unknownVariables(`${copy.subject} ${copy.body_html}`) : []) out.push({ where: i, message: `${label}: {{${v}}} is not a variable Claros knows; the email would fail to render.` });
    } else if (mode === "ai" && (typeof s.brain_instruction !== "string" || s.brain_instruction.trim() === "")) {
      out.push({ where: i, message: `${label}: tell the AI what this email should do.` });
    }
  });
  const orders = draft.steps.map((s) => s.order);
  if (new Set(orders).size !== orders.length) out.push({ where: 0, message: "Two emails share an order." });
  return out;
}

// ---------------------------------------------------------------------------
// Diff for saving
// ---------------------------------------------------------------------------

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface DraftChanges {
  /** PATCH /v1/flows/:id fields. */
  patch: Partial<Record<"name" | "trigger_type" | "trigger_config" | "prompt_source" | keyof FlowSettingsDraft, unknown>>;
  /** Templates to write, by slug (only the ones the steps use). */
  copies: Record<string, StepCopy>;
  /** Whether the steps or exits changed (PUT /steps). */
  plan: boolean;
}

export function draftChanges(saved: EditorDraft, draft: EditorDraft, cleanTrigger: (d: TriggerDraft) => Json): DraftChanges {
  const patch: DraftChanges["patch"] = {};
  if (draft.name.trim() !== saved.name) patch.name = draft.name.trim();
  if (draft.trigger.type !== saved.trigger.type || !same(cleanTrigger(draft.trigger), cleanTrigger(saved.trigger))) {
    patch.trigger_type = draft.trigger.type;
    patch.trigger_config = cleanTrigger(draft.trigger);
  }
  if (draft.prompt !== null && draft.prompt !== saved.prompt) patch.prompt_source = draft.prompt;
  for (const k of ["approval_mode", "topic_id", "flow_class", "priority", "reentry_policy", "reentry_cooldown_days"] as const) {
    if (draft[k] !== saved[k]) patch[k] = draft[k];
  }
  const used = new Set(draft.steps.map((s) => s.template_ref).filter((r): r is string => typeof r === "string"));
  const copies: Record<string, StepCopy> = {};
  for (const [slug, c] of Object.entries(draft.copies)) if (used.has(slug)) copies[slug] = c;
  const plan = !same(planBody(saved), planBody(draft)) || (patch.trigger_type !== undefined && saved.steps.length > 0);
  return { patch, copies, plan };
}

export function hasChanges(c: DraftChanges): boolean {
  return Object.keys(c.patch).length > 0 || Object.keys(c.copies).length > 0 || c.plan;
}

/** content_mode that matches the steps: fixed_content when every email is fixed copy. */
export function contentModeFor(draft: EditorDraft): Flow["content_mode"] {
  if (draft.prompt !== null) return "ai_drafted";
  return draft.steps.length > 0 && draft.steps.every((s) => stepMode(s) === "fixed") ? "fixed_content" : "ai_drafted";
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** Replace {{var}} and {{var|fallback}} with sample values; unknown ones stay visible. */
export function fillSample(text: string, sample: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g, (match, key: string, fallback: string | undefined) => {
    if (sample[key] !== undefined) return sample[key]!;
    if (fallback !== undefined) return fallback;
    return match;
  });
}
