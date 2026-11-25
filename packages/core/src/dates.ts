/**
 * Date-property triggers and schedules (G3): shapes and pure timing logic.
 *
 *   {type: "date_property", property, offset: "-3d", send_at_local?: "09:00", where?}
 *   {type: "date_schedule", anchor, offsets: ["1d", "3d"], repeat?: "30d", max_sends, send_at_local?, where?}
 *
 * Both are schedules over a contact's date trait (the anchor): slot k is due
 * at anchor + offsets[k-1]; past the listed offsets, every `repeat` after the
 * last one, up to `max_sends` slots. A date_property trigger is a schedule of
 * one slot. With `send_at_local`, a slot is due at that local time on the
 * local day of anchor + offset, in the contact's timezone trait, else the
 * product's timezone (throttle.tenant_timezone), else UTC.
 *
 * The engine enrolls a contact once per (flow, contact, anchor value) when a
 * slot is due, and never for slots older than DATE_SLOT_GRACE_MS (a date
 * trait backfilled far in the past does not send a burst of stale mail).
 */
import { z } from "zod";
import { contactConditionSchema } from "./conditions.js";
import { resolveTimezone } from "./throttle/gate.js";

/** Signed duration: "-3d", "12h", "30m", "0m". */
export const SIGNED_DURATION_RE = /^-?\d{1,6}(m|h|d)$/;
/** Unsigned duration: "30d", "2h". */
export const DURATION_RE = /^\d{1,6}(m|h|d)$/;
/** Local time of day, "HH:MM" (24h). */
export const LOCAL_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A slot older than this (relative to now) is never sent; the schedule moves on. */
export const DATE_SLOT_GRACE_MS = 24 * 60 * 60 * 1000;
/** Most slots a schedule may declare (max_sends). */
export const MAX_SCHEDULE_SENDS = 1000;

/** Milliseconds of a (signed) duration string, or null when malformed. */
export function durationMs(raw: string): number | null {
  const m = /^(-?)(\d+)(m|h|d)$/.exec(raw);
  if (!m) return null;
  const n = Number(m[2]) * (m[3] === "m" ? 60_000 : m[3] === "h" ? 3_600_000 : 86_400_000);
  return m[1] === "-" ? -n : n;
}

const property = z.string().min(1).max(64);
const sendAtLocal = z.string().regex(LOCAL_TIME_RE, { message: "send_at_local must look like 09:00" });

export const datePropertyTriggerSchema = z
  .object({
    type: z.literal("date_property"),
    property,
    offset: z.string().regex(SIGNED_DURATION_RE, { message: "offset must look like -3d, 12h or 0m" }),
    send_at_local: sendAtLocal.optional(),
    where: z.array(contactConditionSchema).optional(),
  })
  .strict();

export const dateScheduleTriggerSchema = z
  .object({
    type: z.literal("date_schedule"),
    anchor: property,
    offsets: z.array(z.string().regex(DURATION_RE, { message: "offsets must look like 1d, 12h or 30m" })).min(1).max(100),
    repeat: z.string().regex(DURATION_RE, { message: "repeat must look like 30d" }).optional(),
    max_sends: z.number().int().min(1).max(MAX_SCHEDULE_SENDS),
    send_at_local: sendAtLocal.optional(),
    where: z.array(contactConditionSchema).optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const ms = t.offsets.map((o) => durationMs(o) ?? 0);
    for (let i = 1; i < ms.length; i++) {
      if (ms[i]! <= ms[i - 1]!) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "offsets must be increasing" });
    }
    if (t.repeat !== undefined && (durationMs(t.repeat) ?? 0) <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "repeat must be greater than zero" });
    }
  });

export type DatePropertyTrigger = z.infer<typeof datePropertyTriggerSchema>;
export type DateScheduleTrigger = z.infer<typeof dateScheduleTriggerSchema>;
export type DateTrigger = DatePropertyTrigger | DateScheduleTrigger;

export const DATE_TRIGGER_TYPES = ["date_property", "date_schedule"] as const;

/** True for the two date trigger types. */
export function isDateTriggerType(type: unknown): type is DateTrigger["type"] {
  return type === "date_property" || type === "date_schedule";
}

/**
 * Parse a stored trigger ({type} plus config, as flows keep it: trigger_type
 * and trigger_config, or compiled_plan.trigger {type, condition}). Returns
 * null when it is not a valid date trigger.
 */
export function parseDateTrigger(type: unknown, config: unknown): DateTrigger | null {
  if (!isDateTriggerType(type)) return null;
  const obj = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const schema = type === "date_property" ? datePropertyTriggerSchema : dateScheduleTriggerSchema;
  const parsed = schema.safeParse({ ...obj, type });
  return parsed.success ? parsed.data : null;
}

/** The date trait a trigger is anchored on. */
export function dateTriggerProperty(t: DateTrigger): string {
  return t.type === "date_property" ? t.property : t.anchor;
}

/** Number of slots (sends) of a trigger. */
export function totalSlots(t: DateTrigger): number {
  if (t.type === "date_property") return 1;
  return t.repeat ? t.max_sends : Math.min(t.max_sends, t.offsets.length);
}

/** Offset of slot k (1-based) from the anchor, in ms, or null past the last slot. */
export function slotOffsetMs(t: DateTrigger, k: number): number | null {
  if (k < 1 || k > totalSlots(t)) return null;
  if (t.type === "date_property") return durationMs(t.offset);
  if (k <= t.offsets.length) return durationMs(t.offsets[k - 1]!);
  const last = durationMs(t.offsets[t.offsets.length - 1]!) ?? 0;
  return last + (k - t.offsets.length) * (durationMs(t.repeat!) ?? 0);
}

/**
 * Parse a date trait value: an ISO-8601 string (a bare YYYY-MM-DD is
 * midnight UTC) or epoch seconds / milliseconds as a number. Null when the
 * value is not a date.
 */
export function parseDateValue(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = Math.abs(v) < 1e11 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function localParts(date: Date, tz: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour") % 24, mi: get("minute") };
}

/**
 * The instant at local time "HH:MM" on the local calendar day of `instant`
 * in `tz`. Handles DST by correcting the zone offset once.
 */
export function atLocalTime(instant: Date, hhmm: string, tz: string): Date {
  const [hh, mm] = hhmm.split(":").map(Number) as [number, number];
  const day = localParts(instant, tz);
  const wantedUtc = Date.UTC(day.y, day.mo - 1, day.d, hh, mm);
  // Offset of the zone at the guessed instant, then correct once.
  let guess = wantedUtc;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), tz);
    const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    guess += wantedUtc - asUtc;
  }
  return new Date(guess);
}

/** Effective timezone for send_at_local: contact trait, product timezone, UTC. */
export function dateTimezone(contactTimezone: unknown, productTimezone: string | null | undefined): string {
  return resolveTimezone(typeof contactTimezone === "string" ? contactTimezone : null, productTimezone ?? null);
}

/** When slot k is due, or null past the last slot. */
export function slotDue(t: DateTrigger, anchor: Date, k: number, tz: string): Date | null {
  const off = slotOffsetMs(t, k);
  if (off === null) return null;
  const at = new Date(anchor.getTime() + off);
  return t.send_at_local ? atLocalTime(at, t.send_at_local, tz) : at;
}

/**
 * The first slot at or after `fromSlot` that is not older than the grace
 * window (due >= now - grace), or null when none is left.
 */
export function firstOpenSlot(t: DateTrigger, anchor: Date, now: Date, tz: string, fromSlot = 1): { slot: number; due: Date } | null {
  const total = totalSlots(t);
  const floor = now.getTime() - DATE_SLOT_GRACE_MS;
  for (let k = Math.max(1, fromSlot); k <= total; k++) {
    const due = slotDue(t, anchor, k, tz);
    if (due && due.getTime() >= floor) return { slot: k, due };
  }
  return null;
}

/**
 * Anchor values whose schedule can have a slot due within [now - grace, now]
 * (with a two-day margin for send_at_local shifts): the scan's lookup range
 * into contact_dates. Callers re-check each candidate with firstOpenSlot.
 */
export function anchorWindow(t: DateTrigger, now: Date): { from: Date; to: Date } {
  const margin = 2 * 86_400_000;
  const first = slotOffsetMs(t, 1) ?? 0;
  const last = slotOffsetMs(t, totalSlots(t)) ?? first;
  return {
    from: new Date(now.getTime() - last - DATE_SLOT_GRACE_MS - margin),
    to: new Date(now.getTime() - first + margin),
  };
}

/** The plan step for slot k of a schedule: the step with the greatest order <= k (else the first). */
export function stepForSlot<S extends { order: number }>(steps: readonly S[], k: number): S | undefined {
  const sorted = [...steps].sort((a, b) => a.order - b.order);
  let pick: S | undefined = sorted[0];
  for (const s of sorted) if (s.order <= k) pick = s;
  return pick;
}

/**
 * The plan step a message of `stepOrder` belongs to: for a date_schedule
 * plan, the step for that slot (stepForSlot); otherwise the step with that
 * exact order.
 */
export function planStepFor<S extends { order: number }>(plan: { trigger?: { type?: unknown }; steps: readonly S[] }, stepOrder: number): S | undefined {
  if (plan.trigger?.type === "date_schedule") return stepForSlot(plan.steps, stepOrder);
  return plan.steps.find((s) => s.order === stepOrder);
}
