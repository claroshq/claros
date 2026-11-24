/**
 * Throttle gate - pure decision function.
 *
 * The gate evaluates three layers in order:
 *   L1: Suppression (hard block, never bypassed - even by critical flows)
 *   L2: Frequency cap (per-contact rate limiting)
 *   L3: Send window (timezone-aware timing)
 *
 * flow_class = 'critical' with critical_bypass_throttle = true skips L2 and L3.
 * L1 is a legal exclusion (CLAUDE.md iron rule) and is NEVER bypassed.
 *
 * The gate does NOT check "duplicate_pending" - that is handled by the scan
 * phase's unique index (membership_id, flow_step_order) which prevents two
 * messages for the same flow step. Cross-flow over-mailing to the same contact
 * is prevented by L2's frequency cap, not by a duplicate check. A contact can
 * legitimately have messages from multiple flows in flight simultaneously; it is
 * the frequency cap that ensures they are delivered at a safe rate.
 *
 * The gate is a PURE function: no I/O, no DB access. All inputs are pre-fetched
 * by the caller (drain worker). This makes it fully unit-testable with synthetic data.
 */
import type { ThrottleConfig } from "./defaults.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Inputs the caller must provide (fetched from DB by the drain worker). */
export interface ThrottleGateInput {
  /** Whether the contact's email appears in the suppressions table. */
  isSuppressed: boolean;

  /** flow_class of the flow that owns this message. */
  flowClass: "critical" | "nurture";

  /** The step's window_policy (from compiled plan). */
  windowPolicy: "immediate" | "respect_window";

  /** Resolved throttle config for this tenant (via resolveThrottleConfig). */
  config: ThrottleConfig;

  /**
   * Recent send history for this contact. The gate needs:
   *   - Count of messages sent in the last 24h
   *   - Count of messages sent in the last 7d
   *   - Timestamp of the most recent sent message (or null if never sent)
   */
  recentSends: {
    countLast24h: number;
    countLast7d: number;
    lastSentAt: Date | null;
  };

  /**
   * Contact's timezone (from properties.timezone). May be null (unknown) or
   * an invalid string (customer-supplied garbage). The fallback chain:
   *   1. contactTimezone (if valid IANA zone)
   *   2. config.tenant_timezone (if valid IANA zone)
   *   3. "UTC"
   */
  contactTimezone: string | null;

  /** The current time (injected for testability). */
  now: Date;
}

/** Discriminated union result. The drain uses this to decide what to do. */
export type ThrottleVerdict =
  | { outcome: "allow" }
  | { outcome: "suppress"; reason: string }
  | { outcome: "defer_frequency"; retryAfter: Date }
  | { outcome: "defer_window"; retryAfter: Date };

// ---------------------------------------------------------------------------
// Gate function
// ---------------------------------------------------------------------------

/**
 * Evaluate the throttle gate for a single message. Returns a verdict that tells
 * the drain what to do:
 *   - allow: send immediately
 *   - suppress: mark as suppressed (terminal), never retry
 *   - defer_frequency: frequency cap hit, retry after retryAfter
 *   - defer_window: outside send window, retry when window opens
 */
export function evaluateThrottleGate(input: ThrottleGateInput): ThrottleVerdict {
  // -------------------------------------------------------------------------
  // L1: Suppression (hard block, NEVER bypassed)
  // -------------------------------------------------------------------------
  if (input.isSuppressed) {
    return { outcome: "suppress", reason: "contact_email_suppressed" };
  }

  // -------------------------------------------------------------------------
  // Critical bypass: skip L2 + L3 when flow_class = critical and tenant allows
  // -------------------------------------------------------------------------
  const isCriticalBypass =
    input.flowClass === "critical" && input.config.critical_bypass_throttle;

  if (isCriticalBypass) {
    return { outcome: "allow" };
  }

  // -------------------------------------------------------------------------
  // L2: Frequency cap
  // -------------------------------------------------------------------------
  const frequencyVerdict = checkFrequencyCap(input);
  if (frequencyVerdict !== null) {
    return frequencyVerdict;
  }

  // -------------------------------------------------------------------------
  // L3: Send window
  // -------------------------------------------------------------------------
  if (input.windowPolicy === "immediate") {
    return { outcome: "allow" };
  }

  const windowVerdict = checkSendWindow(input);
  if (windowVerdict !== null) {
    return windowVerdict;
  }

  return { outcome: "allow" };
}

// ---------------------------------------------------------------------------
// L2: Frequency cap check
// ---------------------------------------------------------------------------

function checkFrequencyCap(input: ThrottleGateInput): ThrottleVerdict | null {
  const { config, recentSends, now } = input;

  // Check min_interval_between_emails_hours
  if (recentSends.lastSentAt !== null && config.min_interval_between_emails_hours > 0) {
    const minIntervalMs = config.min_interval_between_emails_hours * 60 * 60 * 1000;
    const elapsed = now.getTime() - recentSends.lastSentAt.getTime();
    if (elapsed < minIntervalMs) {
      const retryAfter = new Date(recentSends.lastSentAt.getTime() + minIntervalMs);
      return { outcome: "defer_frequency", retryAfter };
    }
  }

  // Check daily cap
  if (recentSends.countLast24h >= config.max_emails_per_user_per_day) {
    // Retry after 24h from now (conservative: the oldest message in the 24h window
    // will age out, but we don't have its exact time here, so next-day is safe)
    const retryAfter = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    return { outcome: "defer_frequency", retryAfter };
  }

  // Check weekly cap
  if (recentSends.countLast7d >= config.max_emails_per_user_per_week) {
    // Retry after 7 days from now (conservative)
    const retryAfter = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    return { outcome: "defer_frequency", retryAfter };
  }

  return null;
}

// ---------------------------------------------------------------------------
// L3: Send window check
// ---------------------------------------------------------------------------

function checkSendWindow(input: ThrottleGateInput): ThrottleVerdict | null {
  const { config, contactTimezone, now } = input;

  // Resolve the effective timezone via the fallback chain:
  //   1. contactTimezone (if valid IANA zone)
  //   2. config.tenant_timezone (if valid IANA zone)
  //   3. "UTC"
  const tz = resolveTimezone(contactTimezone, config.tenant_timezone);

  // Get current local time in the resolved timezone
  const localNow = getLocalTime(now, tz);

  // Check if today is an allowed send day
  const dayName = getDayName(localNow.dayOfWeek);
  const windowStart = parseTimeOfDay(config.send_window_start);
  const windowEnd = parseTimeOfDay(config.send_window_end);

  if (dayName !== null && config.send_window_days.includes(dayName)) {
    // Today is a send day - check if we're within the time window
    const currentMinutes = localNow.hour * 60 + localNow.minute;
    if (currentMinutes >= windowStart && currentMinutes < windowEnd) {
      return null; // Within window - allow
    }
  }

  // Outside window (either wrong day or wrong time) - compute next opening
  const retryAfter = computeNextWindowOpen(localNow, config, tz, now);
  return { outcome: "defer_window", retryAfter };
}

// ---------------------------------------------------------------------------
// Timezone utilities
// ---------------------------------------------------------------------------

/** Local time components for window evaluation. */
interface LocalTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  dayOfWeek: number; // 0=Sunday, 1=Monday, ... 6=Saturday
}

/**
 * Resolve the effective timezone using the fallback chain:
 *   1. contactTimezone if it is a valid IANA zone
 *   2. tenantTimezone if it is a valid IANA zone
 *   3. "UTC"
 */
export function resolveTimezone(
  contactTimezone: string | null | undefined,
  tenantTimezone: string | null | undefined,
): string {
  if (contactTimezone && isValidTimezone(contactTimezone)) {
    return contactTimezone;
  }
  if (tenantTimezone && isValidTimezone(tenantTimezone)) {
    return tenantTimezone;
  }
  return "UTC";
}

/**
 * Validate an IANA timezone string. Returns false for garbage values.
 * Uses Intl.DateTimeFormat which throws on invalid timezone identifiers.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get local time components for a given Date in a given timezone.
 * The timezone has already been validated by resolveTimezone.
 */
function getLocalTime(date: Date, tz: string): LocalTime {
  // Use Intl to decompose the date in the target timezone
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = formatter.formatToParts(date);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "0";

  const weekdayStr = get("weekday"); // "Mon", "Tue", etc.
  const dayOfWeek = weekdayToNumber(weekdayStr);

  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    hour: parseInt(get("hour"), 10),
    minute: parseInt(get("minute"), 10),
    dayOfWeek,
  };
}

function weekdayToNumber(wd: string): number {
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[wd] ?? 0;
}

function getDayName(
  dayOfWeek: number,
): "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun" | null {
  const names: Record<number, "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"> = {
    0: "sun",
    1: "mon",
    2: "tue",
    3: "wed",
    4: "thu",
    5: "fri",
    6: "sat",
  };
  return names[dayOfWeek] ?? null;
}

/** Parse "HH:MM" -> minutes since midnight. */
function parseTimeOfDay(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Compute the next window opening time as a UTC Date.
 *
 * Walks forward day-by-day (max 8 days to account for all-days-disabled edge)
 * from the current local time until it finds a day in send_window_days, then
 * returns the window_start time on that day converted back to UTC.
 */
function computeNextWindowOpen(
  localNow: LocalTime,
  config: ThrottleConfig,
  tz: string,
  utcNow: Date,
): Date {
  const windowStart = parseTimeOfDay(config.send_window_start);
  const currentMinutes = localNow.hour * 60 + localNow.minute;

  // Check if we're on a valid day but before the window opens
  const todayName = getDayName(localNow.dayOfWeek);
  if (todayName && config.send_window_days.includes(todayName) && currentMinutes < windowStart) {
    // Today is valid, window hasn't opened yet - next opening is today at window_start
    const diffMinutes = windowStart - currentMinutes;
    return new Date(utcNow.getTime() + diffMinutes * 60 * 1000);
  }

  // Need to find the next valid day. Walk forward from tomorrow.
  for (let offset = 1; offset <= 8; offset++) {
    const futureDow = (localNow.dayOfWeek + offset) % 7;
    const futureDayName = getDayName(futureDow);
    if (futureDayName && config.send_window_days.includes(futureDayName)) {
      // Compute the time difference: offset days from today at window_start
      const minutesUntilMidnight = (24 * 60) - currentMinutes;
      const fullDaysMinutes = (offset - 1) * 24 * 60;
      const totalMinutesFromNow = minutesUntilMidnight + fullDaysMinutes + windowStart;
      return new Date(utcNow.getTime() + totalMinutesFromNow * 60 * 1000);
    }
  }

  // Fallback: should not happen unless send_window_days is empty (which defaults prevent).
  // Return 24h from now as a safe fallback.
  return new Date(utcNow.getTime() + 24 * 60 * 60 * 1000);
}
