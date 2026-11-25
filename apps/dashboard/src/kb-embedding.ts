/**
 * Embedding state of a knowledge base entry, as badges.
 *
 * null = embedded (the vector is the evidence); "skipped" = no vector and
 * no job queued: no embedding provider was configured when it ran, or the
 * vectors were dropped after a model change and Retry has not reached it.
 * Pinned entries, kb_select and kb_ref use an entry either way.
 */
import type { BadgeVariant } from "./components/ui/badge.js";

export type EmbeddingStatus = "pending" | "failed" | "skipped" | null;

export function embeddingVariant(status: EmbeddingStatus): BadgeVariant {
  switch (status) {
    case "pending": return "warning";
    case "failed": return "danger";
    case "skipped": return "muted";
    case null: return "success";
  }
}

export function embeddingLabel(status: EmbeddingStatus): string {
  switch (status) {
    case "pending": return "embedding";
    case "failed": return "embed failed";
    case "skipped": return "not embedded";
    case null: return "embedded";
  }
}
