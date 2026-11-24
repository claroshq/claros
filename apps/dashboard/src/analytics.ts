/**
 * Analytics hooks.
 */
import { useQuery } from "@tanstack/react-query";
import {
  fetchLifecycleAnalytics,
  fetchSendingAnalytics,
  fetchRetentionGrid,
  fetchRetentionGridCellTrend,
} from "./api.js";

export function useLifecycleAnalytics(days: number) {
  return useQuery({
    queryKey: ["analytics", "lifecycle", days],
    queryFn: () => fetchLifecycleAnalytics(days),
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
