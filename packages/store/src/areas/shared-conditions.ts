/**
 * Lookups for contact conditions (G4 traits, G28 send history), shared by
 * the worker areas that evaluate conditions (advance-membership,
 * scan-step-advancement, trigger-check).
 */
export interface SendCountInput {
  tenantId: string;
  contactId: string;
  /** Flow slug or flow id. */
  flow?: string;
  actionType?: string;
  /** Topic slug. */
  topic?: string;
  /** Only sends at or after this time; null = all time. */
  since: Date | null;
}

/** The reserved traits ingest stores in their own columns instead of properties. */
export type ReservedTraitColumns = {
  email: string | null;
  name: string | null;
  company: string | null;
  payment_status: string | null;
};

/**
 * The traits a condition sees: properties plus the reserved traits (email,
 * name, company, payment_status, which ingest moves out of properties into
 * columns). Without the columns a condition on payment_status saw it as
 * absent for every contact, so `payment_status neq "past_due"` was always
 * true. A column wins over a stale property of the same name; a NULL column
 * leaves the trait absent.
 */
export function withReservedTraits(properties: Record<string, unknown>, cols: ReservedTraitColumns): Record<string, unknown> {
  const out: Record<string, unknown> = { ...properties };
  for (const key of ["email", "name", "company", "payment_status"] as const) {
    const v = cols[key];
    if (v !== null && v !== undefined) out[key] = v;
  }
  return out;
}

export interface ContactConditionQueries {
  /**
   * The contact's traits for conditions: properties plus the reserved
   * columns (withReservedTraits). {} when unset, null when the contact does
   * not exist.
   */
  getContactTraits(input: { tenantId: string; contactId: string }): Promise<Record<string, unknown> | null>;
  /**
   * Number of the contact's messages in this product that were sent or are
   * being sent (status sent or sending), matching the filters, with sent_at
   * at or after `since` when given.
   */
  countSends(input: SendCountInput): Promise<number>;
  /** The contact's lifecycle state, null when the contact does not exist (P5b audience conditions). */
  lookupLifecycleState(input: { tenantId: string; contactId: string }): Promise<string | null>;
}
