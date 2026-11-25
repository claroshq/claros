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

/** Any of the three G4/G28 shapes. */
export const contactConditionSchema = z.union([traitConditionSchema, historyConditionSchema, firstContactConditionSchema]);

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
 * Used for event triggers' `where`.
 */
export async function evaluateAllContactConditions(conds: readonly unknown[], ctx: ContactConditionContext): Promise<boolean | null> {
  for (const cond of conds) {
    const r = await evaluateContactCondition(cond, ctx);
    if (r === null) return null;
    if (!r) return false;
  }
  return true;
}

/** Memoize the lookups of a context for one evaluation pass. */
export function cachedConditionContext(ctx: ContactConditionContext): ContactConditionContext {
  let traits: Promise<Record<string, unknown>> | null = null;
  const counts = new Map<string, Promise<number>>();
  return {
    now: ctx.now,
    traits: () => (traits ??= ctx.traits()),
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
