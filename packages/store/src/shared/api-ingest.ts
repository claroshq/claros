/**
 * Pure (non-SQL) ingest decisions shared by Store implementations that cannot
 * interleave them with I/O inside a transaction (the D1 implementation).
 *
 * The logic is the decision part of evaluateAndApplyTransition in
 * ../pg/api-ingest.ts, split into "which event names must be read" and
 * "which transition follows", with the same @claros/core functions and the
 * same short-circuits. The Postgres implementation keeps its own inline copy.
 */
import {
  evaluateEventTransition,
  isActivationRelevantEvent,
  checkActivationSatisfied,
  isEngagementEvent,
  resolveLifecycleConfig,
  type LifecycleState,
  type LifecycleConfig,
} from "@claros/core";

export interface IngestTransitionPlan {
  from: LifecycleState;
  to: LifecycleState;
  setActivatedAt: boolean;
}

/** Lifecycle config from a tenant's settings JSON (defaults merged with overrides). */
export function lifecycleConfigFromSettings(settings: unknown): LifecycleConfig {
  const s = settings as Record<string, unknown> | null | undefined;
  const lifecycleOverrides = s?.lifecycle as Partial<LifecycleConfig> | null | undefined;
  return resolveLifecycleConfig(lifecycleOverrides);
}

/**
 * Whether the event bumps last_seen_at and the engagement counter
 * (settings.lifecycle.engagement_events; eventName null = identify).
 */
export function countsAsActivity(eventName: string | null, config: LifecycleConfig): boolean {
  return isEngagementEvent(eventName, config.engagement_events);
}

/**
 * The activation event names whose history must be read for this event, or
 * an empty list when the decision needs no event history.
 */
export function activationEventsToRead(
  currentState: LifecycleState,
  eventName: string | null,
  config: LifecycleConfig,
): string[] {
  if (currentState !== "signed_up") return [];
  if (config.activation_events.length === 0) return [];
  if (!isActivationRelevantEvent(eventName, config.activation_events)) return [];
  return config.activation_events;
}

/**
 * The lifecycle transition an ingested event causes, or null.
 *
 * `priorEventNames` are the distinct track event names the contact produced
 * (restricted to activationEventsToRead); the current event is added here.
 */
export function planIngestTransition(input: {
  currentState: LifecycleState;
  eventName: string | null;
  config: LifecycleConfig;
  priorEventNames: Iterable<string>;
}): IngestTransitionPlan | null {
  const { currentState, eventName, config } = input;
  if (currentState === "engaged" || currentState === "resurrected") return null;

  let activationSatisfied = false;
  if (currentState === "signed_up") {
    if (config.activation_events.length === 0) return null;
    if (!isActivationRelevantEvent(eventName, config.activation_events)) return null;
    const names = new Set(input.priorEventNames);
    if (eventName !== null) names.add(eventName);
    activationSatisfied = checkActivationSatisfied(names, config.activation_events);
  }

  const transition = evaluateEventTransition({
    currentState,
    eventName,
    activationSatisfied,
    countsAsActivity: isEngagementEvent(eventName, config.engagement_events),
  });
  if (transition === null) return null;
  return { from: transition.from, to: transition.to, setActivatedAt: transition.setActivatedAt };
}
