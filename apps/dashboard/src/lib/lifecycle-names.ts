/**
 * Lifecycle state names in the dashboard.
 *
 * `churned` was renamed `gone_quiet`: no product activity for
 * gone_quiet_days, which says nothing about billing (a paying customer can
 * be gone quiet). Until the next minor release the API still returns
 * `churned`, so the dashboard keeps `churned` as the value it sends
 * and shows `gone_quiet` wherever a state name is displayed. Config written
 * by hand may already say `gone_quiet`; storedState maps it back so selects
 * show it.
 */

/** The name to display for a stored lifecycle state. */
export function stateName(state: string): string {
  return state === "churned" ? "gone_quiet" : state;
}

/** The stored value for a state name (gone_quiet -> churned). */
export function storedState(state: string): string {
  return state === "gone_quiet" ? "churned" : state;
}

/** Tooltip for the gone_quiet state. */
export const GONE_QUIET_HINT =
  "No product activity for the gone quiet threshold (settings.lifecycle.gone_quiet_days). Not a billing status: a paying customer can be gone quiet.";

/** The tooltip for a stored state, if it has one. */
export function stateHint(state: string): string | undefined {
  return state === "churned" ? GONE_QUIET_HINT : undefined;
}
