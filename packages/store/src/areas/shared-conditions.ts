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

export interface ContactConditionQueries {
  /** The contact's traits (properties), {} when unset, null when the contact does not exist. */
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
