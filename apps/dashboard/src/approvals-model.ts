/**
 * Pure helpers of the Approvals screen, kept out of the page so they can be
 * tested without a DOM.
 */

/**
 * The row to show after the row `id` leaves the queue: the next one down,
 * or the one above when it was the last. Null when nothing is left.
 * Reviewing works top to bottom, so a decision moves forward, never back to
 * the top of the queue.
 */
export function nextSelection(ids: readonly string[], id: string): string | null {
  const index = ids.indexOf(id);
  if (index === -1) return ids[0] ?? null;
  return ids[index + 1] ?? ids[index - 1] ?? null;
}

/** The three views of the screen, kept in the URL (?view=). */
export type ApprovalsView = "review" | "approved" | "attention";

export function parseView(value: string | null): ApprovalsView {
  return value === "approved" || value === "attention" ? value : "review";
}

/**
 * The flow name shared by every loaded draft, or null when they come from
 * more than one flow. When one flow fills the queue, its name moves to the
 * queue header instead of repeating on every row.
 */
export function sharedFlowId(flowIds: readonly string[]): string | null {
  if (flowIds.length === 0) return null;
  const first = flowIds[0]!;
  return flowIds.every((f) => f === first) ? first : null;
}
