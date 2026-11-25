/**
 * Queries used by packages/api/src/routes/import.ts (G21 history import).
 */

/** One historical message, validated by the route. */
export interface HistoryImportItem {
  /** Position in the request (for error reports). */
  index: number;
  externalId: string | null;
  email: string | null;
  flowSlug: string;
  stepOrder: number;
  actionType: string;
  subject: string | null;
  sentAt: Date;
  kbExternalKey: string | null;
  /** Idempotency key (caller id or derived). */
  importKey: string;
}

export interface HistoryImportResult {
  imported: number;
  duplicates: number;
  errors: Array<{ index: number; error: string }>;
}

export interface ApiImportQueries {
  /**
   * Store historical sent messages (status 'sent', imported = true), each
   * with a completed membership (exit_reason 'imported', entered and
   * completed at sent_at) so re-entry, throttle, history conditions and
   * kb_select exclude_used see them. Contacts resolve by external id, else
   * by email (case-insensitive); flows by slug; KB entries by external key.
   * An item whose import_key exists is a duplicate (nothing written).
   * Unresolvable items are reported in errors. With dryRun nothing is
   * written. Each item is one atomic unit.
   */
  importMessages(input: { tenantId: string; items: HistoryImportItem[]; dryRun: boolean; now: Date }): Promise<HistoryImportResult>;
}
