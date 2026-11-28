/**
 * Badge tones for a person's lifecycle state and message statuses, shared
 * by the Person page and the Approvals person card.
 */
import type { BadgeVariant } from "../components/ui/badge.js";
import type { Contact } from "../api.js";

export function stateVariant(state: Contact["lifecycle_state"]): BadgeVariant {
  switch (state) {
    case "signed_up": return "neutral";
    case "activated": return "accent";
    case "engaged": return "success";
    case "at_risk": return "warning";
    case "dormant": return "muted";
    case "gone_quiet": return "danger";
    // Older servers (before the gone_quiet rename) return churned.
    case "churned": return "danger";
    case "resurrected": return "success";
  }
}

export function membershipVariant(status: string): BadgeVariant {
  switch (status) {
    case "active": return "success";
    case "paused": return "warning";
    case "completed": return "muted";
    case "exited": return "neutral";
    default: return "neutral";
  }
}

export function messageVariant(status: string): BadgeVariant {
  switch (status) {
    case "sent": return "success";
    case "approved": return "accent";
    case "pending_approval": return "warning";
    case "rejected":
    case "failed":
    case "suppressed": return "danger";
    case "skipped":
    case "value_gated": return "muted";
    default: return "neutral";
  }
}
