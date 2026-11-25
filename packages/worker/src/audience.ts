/**
 * Trigger `where` (P5b): audience conditions checked before a contact is
 * enrolled, for every trigger type (event, lifecycle_transition, segment,
 * manual, date_property, date_schedule).
 */
import {
  cachedConditionContext,
  evaluateAudienceCondition,
  type ContactConditionContext,
} from "@claros/core";
import type { ContactConditionQueries } from "@claros/store";

/** A cached condition context for one contact, backed by a store area's lookups. */
export function audienceContext(
  store: ContactConditionQueries,
  tenantId: string,
  contactId: string,
  now: Date,
): ContactConditionContext {
  return cachedConditionContext({
    now,
    traits: async () => (await store.getContactTraits({ tenantId, contactId })) ?? {},
    countSends: (f) => store.countSends({ tenantId, contactId, ...f }),
    lifecycleState: () => store.lookupLifecycleState({ tenantId, contactId }),
  });
}

/** The trigger's `where` from a trigger_config (undefined when absent). */
export function triggerWhere(triggerConfig: unknown): unknown {
  if (!triggerConfig || typeof triggerConfig !== "object") return undefined;
  return (triggerConfig as { where?: unknown }).where;
}

/** True when the contact passes the trigger's `where` (no `where`: true; malformed: false). */
export async function passesTriggerWhere(
  store: ContactConditionQueries,
  triggerConfig: unknown,
  tenantId: string,
  contactId: string,
  now: Date,
): Promise<boolean> {
  const where = triggerWhere(triggerConfig);
  if (where === undefined || where === null) return true;
  return (await evaluateAudienceCondition(where, audienceContext(store, tenantId, contactId, now))) === true;
}
