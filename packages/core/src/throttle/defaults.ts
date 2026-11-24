/**
 * Throttle configuration defaults and resolver.
 *
 * Defaults sourced from CLAROS_HANDOFF_V2.md Appendix B. A tenant with no
 * throttle config (settings.throttle is null/missing/partial) gets these values.
 * Absent config NEVER means unlimited sending - the failure direction is always
 * toward throttling, not toward unbounded delivery.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// ThrottleConfig schema and type
// ---------------------------------------------------------------------------

export const throttleConfigSchema = z.object({
  max_emails_per_user_per_day: z.number().int().min(0),
  max_emails_per_user_per_week: z.number().int().min(0),
  min_interval_between_emails_hours: z.number().min(0),
  send_window_start: z.string().regex(/^\d{2}:\d{2}$/),
  send_window_end: z.string().regex(/^\d{2}:\d{2}$/),
  send_window_days: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])),
  send_window_timezone: z.enum(["contact_local", "tenant_fixed"]),
  tenant_timezone: z.string().optional(),
  batch_size_per_tick: z.number().int().min(1),
  critical_bypass_throttle: z.boolean(),
});

export type ThrottleConfig = z.infer<typeof throttleConfigSchema>;

// ---------------------------------------------------------------------------
// Defaults (Appendix B)
// ---------------------------------------------------------------------------

export const THROTTLE_DEFAULTS: ThrottleConfig = {
  max_emails_per_user_per_day: 1,
  max_emails_per_user_per_week: 2,
  min_interval_between_emails_hours: 48,
  send_window_start: "09:00",
  send_window_end: "17:00",
  send_window_days: ["mon", "tue", "wed", "thu", "fri"],
  send_window_timezone: "contact_local",
  tenant_timezone: undefined,
  batch_size_per_tick: 10,
  critical_bypass_throttle: true,
};

// ---------------------------------------------------------------------------
// Resolver: merge partial tenant settings over defaults
// ---------------------------------------------------------------------------

/**
 * Resolves a fully-populated ThrottleConfig from a tenant's settings.throttle
 * JSONB value (which may be null, partial, or garbage). Every missing or invalid
 * field falls back to the documented default from Appendix B.
 *
 * Safety guarantee: the returned config is always a valid, complete
 * ThrottleConfig. A tenant that has never configured throttle gets the
 * documented defaults - not unlimited sending.
 */
export function resolveThrottleConfig(raw: unknown): ThrottleConfig {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return { ...THROTTLE_DEFAULTS };
  }

  // Merge field-by-field: use the raw value if it passes individual validation,
  // otherwise fall back to the default for that field.
  const input = raw as Record<string, unknown>;
  const result: ThrottleConfig = { ...THROTTLE_DEFAULTS };

  const intField = (key: keyof ThrottleConfig, min: number) => {
    const v = input[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= min) {
      (result as Record<string, unknown>)[key] = v;
    }
  };

  const numField = (key: keyof ThrottleConfig, min: number) => {
    const v = input[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= min) {
      (result as Record<string, unknown>)[key] = v;
    }
  };

  intField("max_emails_per_user_per_day", 0);
  intField("max_emails_per_user_per_week", 0);
  numField("min_interval_between_emails_hours", 0);
  intField("batch_size_per_tick", 1);

  // send_window_start / end: HH:MM format
  if (typeof input.send_window_start === "string" && /^\d{2}:\d{2}$/.test(input.send_window_start)) {
    result.send_window_start = input.send_window_start;
  }
  if (typeof input.send_window_end === "string" && /^\d{2}:\d{2}$/.test(input.send_window_end)) {
    result.send_window_end = input.send_window_end;
  }

  // send_window_days: array of valid day strings
  const validDays = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
  if (Array.isArray(input.send_window_days)) {
    const filtered = input.send_window_days.filter(
      (d): d is string => typeof d === "string" && validDays.has(d),
    );
    if (filtered.length > 0) {
      result.send_window_days = filtered as ThrottleConfig["send_window_days"];
    }
  }

  // send_window_timezone
  if (input.send_window_timezone === "contact_local" || input.send_window_timezone === "tenant_fixed") {
    result.send_window_timezone = input.send_window_timezone;
  }

  // tenant_timezone: string or undefined
  if (typeof input.tenant_timezone === "string" && input.tenant_timezone.length > 0) {
    result.tenant_timezone = input.tenant_timezone;
  }

  // critical_bypass_throttle
  if (typeof input.critical_bypass_throttle === "boolean") {
    result.critical_bypass_throttle = input.critical_bypass_throttle;
  }

  return result;
}
