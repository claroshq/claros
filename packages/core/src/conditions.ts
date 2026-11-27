/**
 * Trait conditions (G4), send-history conditions and first contact (G28):
 * shapes and pure evaluation. Usable on step conditions, step and plan
 * exits, and event triggers (`{event, where: [conditions]}`).
 *
 *   {trait: {key, op: eq|neq|in|exists|not_exists|gt|lt, value?}}
 *   {history: {flow?|action_type?|topic?, within?, op: none|any|count_lt, value?}}
 *   {first_contact: true|false}
 *
 * Traits are the contact's properties (identify traits); `key` may be a
 * dotted path into nested objects. History counts messages sent (or being
 * sent) to the contact in this product, optionally filtered by flow (slug
 * or id), action type or topic slug, within a window ("7d", "12h", "30m";
 * absent = all time). The lookups are the caller's (store methods); this
 * module only decides.
 */
import { z } from "zod";
import { storedLifecycleState } from "./lifecycle/states.js";

export const TRAIT_OPS = ["eq", "neq", "in", "exists", "not_exists", "gt", "lt"] as const;
export type TraitOp = (typeof TRAIT_OPS)[number];
export const HISTORY_OPS = ["none", "any", "count_lt"] as const;
export type HistoryOp = (typeof HISTORY_OPS)[number];

const WINDOW_RE = /^(\d+)(m|h|d)$/;

export const traitConditionSchema = z
  .object({
    trait: z
      .object({
        key: z.string().min(1).max(200),
        op: z.enum(TRAIT_OPS),
        value: z.unknown().optional(),
      })
      .strict()
      .superRefine((t, ctx) => {
        if (t.op === "in" && !Array.isArray(t.value)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "op 'in' needs an array value" });
        }
        if ((t.op === "eq" || t.op === "neq" || t.op === "gt" || t.op === "lt") && t.value === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `op '${t.op}' needs a value` });
        }
      }),
  })
  .strict();

export const historyConditionSchema = z
  .object({
    history: z
      .object({
        flow: z.string().min(1).optional(),
        action_type: z.string().min(1).optional(),
        topic: z.string().min(1).optional(),
        within: z.string().regex(WINDOW_RE, { message: "within must look like 7d, 12h or 30m" }).optional(),
        op: z.enum(HISTORY_OPS),
        value: z.number().int().min(1).optional(),
      })
      .strict()
      .superRefine((h, ctx) => {
        if (h.op === "count_lt" && h.value === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "op 'count_lt' needs a value" });
        }
      }),
  })
  .strict();

export const firstContactConditionSchema = z.object({ first_contact: z.boolean() }).strict();

/** The contact's current lifecycle state is (or is not) the given one. */
export const lifecycleStateConditionSchema = z.object({ lifecycle_state: z.string().min(1).max(64) }).strict();
export const lifecycleStateNotConditionSchema = z.object({ lifecycle_state_not: z.string().min(1).max(64) }).strict();

/** Any of the three G4/G28 shapes. */
export const contactConditionSchema = z.union([traitConditionSchema, historyConditionSchema, firstContactConditionSchema]);

// ---------------------------------------------------------------------------
// Combinators (P5b): {all: [...]}, {any: [...]}, {not: c}, and lists (= all)
// ---------------------------------------------------------------------------

/** Deepest nesting of combinators a condition may use. */
export const MAX_CONDITION_DEPTH = 4;
/** Most entries in one list or combinator. */
export const MAX_CONDITION_ITEMS = 20;

/** Combinator nesting depth of a condition (a leaf is 0, `{all: [leaf]}` is 1). */
export function conditionDepth(cond: unknown): number {
  if (Array.isArray(cond)) return cond.reduce((m: number, c) => Math.max(m, conditionDepth(c)), 0);
  if (cond === null || typeof cond !== "object") return 0;
  const o = cond as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 1) return 0;
  if (keys[0] === "all" || keys[0] === "any") return 1 + conditionDepth(o[keys[0]]);
  if (keys[0] === "not") return 1 + conditionDepth(o.not);
  return 0;
}

/** True for `{all: [...]}`, `{any: [...]}` and `{not: ...}` (by their single key). */
export function isCombinator(cond: unknown): cond is { all: unknown[] } | { any: unknown[] } | { not: unknown } {
  if (cond === null || typeof cond !== "object" || Array.isArray(cond)) return false;
  const keys = Object.keys(cond);
  return keys.length === 1 && (keys[0] === "all" || keys[0] === "any" || keys[0] === "not");
}

/**
 * A condition tree over `leaf`: a leaf, or `{all: [tree...]}`, `{any:
 * [tree...]}`, `{not: tree}`, at most MAX_CONDITION_DEPTH combinators deep.
 */
export function conditionTreeSchema<T extends z.ZodTypeAny>(leaf: T, name: string): z.ZodType<unknown> {
  const tree: z.ZodType<unknown> = z.lazy(() =>
    z.union([
      leaf,
      z.object({ all: z.array(tree).min(1).max(MAX_CONDITION_ITEMS) }).strict(),
      z.object({ any: z.array(tree).min(1).max(MAX_CONDITION_ITEMS) }).strict(),
      z.object({ not: tree }).strict(),
    ]),
  );
  // The JSON Schema generator (config/json-schema.ts) emits a named $defs entry for it.
  (tree as unknown as { jsonSchemaName: string }).jsonSchemaName = name;
  return tree.superRefine((c, ctx) => {
    if (conditionDepth(c) > MAX_CONDITION_DEPTH) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `conditions nest at most ${MAX_CONDITION_DEPTH} combinators deep` });
    }
  });
}

/** A condition tree, or a list of them (a list means all must hold). */
export function conditionOrListSchema<T extends z.ZodTypeAny>(leaf: T, name: string): z.ZodType<unknown> {
  const tree = conditionTreeSchema(leaf, name);
  return z.union([tree, z.array(tree).min(1).max(MAX_CONDITION_ITEMS)]);
}

/**
 * Evaluate a condition tree (or a list, = all) with `leaf` deciding the
 * leaves. null (from a leaf, or a malformed combinator) means "cannot
 * decide" and propagates. `all` and `any` stop at the first deciding child.
 */
export async function evaluateConditionTree(
  cond: unknown,
  leaf: (c: unknown) => Promise<boolean | null>,
  depth = 0,
): Promise<boolean | null> {
  if (depth > MAX_CONDITION_DEPTH + 1) return null;
  if (Array.isArray(cond)) {
    for (const c of cond) {
      const r = await evaluateConditionTree(c, leaf, depth);
      if (r === null) return null;
      if (!r) return false;
    }
    return true;
  }
  if (!isCombinator(cond)) return leaf(cond);
  if ("not" in cond) {
    const r = await evaluateConditionTree(cond.not, leaf, depth + 1);
    return r === null ? null : !r;
  }
  const items = "all" in cond ? cond.all : cond.any;
  if (!Array.isArray(items) || items.length === 0) return null;
  const wantAll = "all" in cond;
  for (const c of items) {
    const r = await evaluateConditionTree(c, leaf, depth + 1);
    if (r === null) return null;
    if (wantAll && !r) return false;
    if (!wantAll && r) return true;
  }
  return wantAll;
}

/**
 * Audience conditions: trigger `where` and choose-candidate `when`. Leaves:
 * trait, history, first_contact, lifecycle_state, lifecycle_state_not.
 */
export const audienceLeafSchema = z.union([
  traitConditionSchema,
  historyConditionSchema,
  firstContactConditionSchema,
  lifecycleStateConditionSchema,
  lifecycleStateNotConditionSchema,
]);
export const audienceConditionSchema = conditionTreeSchema(audienceLeafSchema, "audienceCondition");
export const audienceConditionOrListSchema = conditionOrListSchema(audienceLeafSchema, "audienceCondition");

export type TraitCondition = z.infer<typeof traitConditionSchema>;
export type HistoryCondition = z.infer<typeof historyConditionSchema>;
export type FirstContactCondition = z.infer<typeof firstContactConditionSchema>;
export type ContactCondition = z.infer<typeof contactConditionSchema>;

/** Filter of a send-history lookup. */
export interface SendHistoryFilter {
  flow?: string;
  actionType?: string;
  topic?: string;
  /** Only sends at or after this time; null = all time. */
  since: Date | null;
}

/** What evaluating a contact condition needs (lazy lookups). */
export interface ContactConditionContext {
  traits(): Promise<Record<string, unknown>>;
  countSends(filter: SendHistoryFilter): Promise<number>;
  /** The contact's lifecycle state (null when unknown). Absent: lifecycle leaves cannot be decided. */
  lifecycleState?: () => Promise<string | null>;
  now: Date;
}

/** Value at a dotted path of the traits, or undefined. */
export function traitValue(traits: Record<string, unknown> | null | undefined, key: string): unknown {
  let cur: unknown = traits ?? {};
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function comparable(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  // "5" equals 5, "true" equals true: identify traits arrive as JSON from many SDKs.
  return String(a) === String(b);
}

/** Decide a trait condition against the contact's traits. */
export function evaluateTrait(cond: TraitCondition["trait"], traits: Record<string, unknown> | null | undefined): boolean {
  const v = traitValue(traits, cond.key);
  const present = v !== undefined && v !== null;
  switch (cond.op) {
    case "exists":
      return present;
    case "not_exists":
      return !present;
    case "eq":
      return present && same(v, cond.value);
    case "neq":
      return !present || !same(v, cond.value);
    case "in":
      return present && Array.isArray(cond.value) && cond.value.some((x) => same(v, x));
    case "gt":
    case "lt": {
      const a = comparable(v);
      const b = comparable(cond.value);
      if (a === null || b === null) return false;
      return cond.op === "gt" ? a > b : a < b;
    }
  }
}

/** Start of a history window ("7d" before now), or null for all time. */
export function historySince(within: string | undefined, now: Date): Date | null {
  if (!within) return null;
  const m = WINDOW_RE.exec(within);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000;
  return new Date(now.getTime() - n * unit);
}

/** Decide a history condition from the matching send count. */
export function historyPasses(cond: HistoryCondition["history"], count: number): boolean {
  switch (cond.op) {
    case "none":
      return count === 0;
    case "any":
      return count > 0;
    case "count_lt":
      return count < (cond.value ?? 0);
  }
}

/** True when the value is one of the G4/G28 shapes (by its single key). */
export function isContactCondition(cond: unknown): boolean {
  if (cond === null || typeof cond !== "object" || Array.isArray(cond)) return false;
  const keys = Object.keys(cond);
  return keys.length === 1 && (keys[0] === "trait" || keys[0] === "history" || keys[0] === "first_contact");
}

/**
 * Evaluate one G4/G28 condition. Returns null when the shape is not valid
 * (callers report it as an unknown shape).
 */
export async function evaluateContactCondition(cond: unknown, ctx: ContactConditionContext): Promise<boolean | null> {
  const parsed = contactConditionSchema.safeParse(cond);
  if (!parsed.success) return null;
  const c = parsed.data;
  if ("trait" in c) return evaluateTrait(c.trait, await ctx.traits());
  if ("history" in c) {
    const count = await ctx.countSends({
      flow: c.history.flow,
      actionType: c.history.action_type,
      topic: c.history.topic,
      since: historySince(c.history.within, ctx.now),
    });
    return historyPasses(c.history, count);
  }
  const sends = await ctx.countSends({ since: null });
  return c.first_contact ? sends === 0 : sends > 0;
}

/**
 * Evaluate a list of conditions (AND). Returns null when any is invalid.
 * Entries may be audience conditions with combinators.
 */
export async function evaluateAllContactConditions(conds: readonly unknown[], ctx: ContactConditionContext): Promise<boolean | null> {
  return evaluateAudienceCondition(conds as unknown[], ctx);
}

/** One audience leaf (trait, history, first_contact, lifecycle_state, lifecycle_state_not). */
async function evaluateAudienceLeaf(cond: unknown, ctx: ContactConditionContext): Promise<boolean | null> {
  if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
    const o = cond as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && (keys[0] === "lifecycle_state" || keys[0] === "lifecycle_state_not")) {
      const want = o[keys[0]];
      if (typeof want !== "string" || want === "" || !ctx.lifecycleState) return null;
      const state = await ctx.lifecycleState();
      const stored = storedLifecycleState(want);
      return keys[0] === "lifecycle_state" ? state === stored : state !== stored;
    }
  }
  return evaluateContactCondition(cond, ctx);
}

/**
 * Evaluate an audience condition: one condition (with combinators) or a
 * list (= all). null when a shape is invalid or cannot be decided. Used for
 * trigger `where` (every trigger type) and choose-candidate `when`.
 */
export async function evaluateAudienceCondition(cond: unknown, ctx: ContactConditionContext): Promise<boolean | null> {
  if (cond === undefined || cond === null || (Array.isArray(cond) && cond.length === 0)) return true;
  if (!audienceConditionOrListSchema.safeParse(cond).success) return null;
  return evaluateConditionTree(cond, (leaf) => evaluateAudienceLeaf(leaf, ctx));
}

/** Memoize the lookups of a context for one evaluation pass. */
export function cachedConditionContext(ctx: ContactConditionContext): ContactConditionContext {
  let traits: Promise<Record<string, unknown>> | null = null;
  let state: Promise<string | null> | null = null;
  const counts = new Map<string, Promise<number>>();
  const lifecycleState = ctx.lifecycleState;
  return {
    now: ctx.now,
    traits: () => (traits ??= ctx.traits()),
    ...(lifecycleState ? { lifecycleState: () => (state ??= lifecycleState()) } : {}),
    countSends: (f) => {
      const key = JSON.stringify([f.flow ?? null, f.actionType ?? null, f.topic ?? null, f.since?.getTime() ?? null]);
      let p = counts.get(key);
      if (!p) {
        p = ctx.countSends(f);
        counts.set(key, p);
      }
      return p;
    },
  };
}
