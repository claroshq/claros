/**
 * Lifecycle state names in the dashboard.
 *
 * `churned` was renamed `gone_quiet`: no product activity for
 * gone_quiet_days, which says nothing about billing (a paying customer can
 * be gone quiet). The API returns `gone_quiet` and accepts both names;
 * flows saved earlier may still say `churned`, and a server before the
 * rename returns it, so both are shown as `gone_quiet`.
 */

/** The name to display for a lifecycle state. */
export function stateName(state: string): string {
  return state === "churned" ? "gone_quiet" : state;
}

/** The current name for a state value (churned -> gone_quiet), so selects show older values. */
export function canonicalState(state: string): string {
  return stateName(state);
}

/** Tooltip for the gone_quiet state. */
export const GONE_QUIET_HINT =
  "No product activity for the gone quiet threshold (settings.lifecycle.gone_quiet_days). Not a billing status: a paying customer can be gone quiet.";

/** The tooltip for a state, if it has one. */
export function stateHint(state: string): string | undefined {
  return state === "churned" || state === "gone_quiet" ? GONE_QUIET_HINT : undefined;
}
