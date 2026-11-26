/**
 * Analytics hooks.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  fetchLifecycleAnalytics,
  fetchSendingAnalytics,
  fetchRetentionGrid,
  fetchRetentionGridCellTrend,
  type ContactAudience,
} from "./api.js";

export function useLifecycleAnalytics(days: number, audience: ContactAudience = "all") {
  return useQuery({
    queryKey: ["analytics", "lifecycle", days, audience],
    queryFn: () => fetchLifecycleAnalytics(days, audience),
    // Switching range or audience keeps the last result on screen while the
    // next one loads, instead of flashing the skeleton.
    placeholderData: keepPreviousData,
  });
}

export function useSendingAnalytics(days: number) {
  return useQuery({
    queryKey: ["analytics", "sending", days],
    queryFn: () => fetchSendingAnalytics(days),
  });
}

export function useRetentionGrid() {
  return useQuery({
    queryKey: ["analytics", "retention-grid"],
    queryFn: fetchRetentionGrid,
  });
}

export function useRetentionGridCellTrend(
  tenure: string | null,
  recency: string | null,
  days: number,
) {
  return useQuery({
    queryKey: ["analytics", "retention-grid", tenure, recency, "trend", days],
    queryFn: () => fetchRetentionGridCellTrend(tenure!, recency!, days),
    enabled: tenure !== null && recency !== null,
  });
}
