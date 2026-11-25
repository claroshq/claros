/**
 * Types shared by the areas that read or write contact topic statuses
 * (apiContacts, apiIngest, apiUnsubscribe).
 */

/** One topic of a product with a contact's status for it. */
export interface ContactTopicStatusRow {
  topicId: string;
  slug: string;
  name: string;
  /** marketing | lifecycle | transactional */
  kind: string;
  defaultSubscribed: boolean;
  /** The explicit status ('subscribed' | 'unsubscribed'), or null when there is no row (default applies). */
  status: string | null;
  source: string | null;
  updatedAt: Date | null;
}
