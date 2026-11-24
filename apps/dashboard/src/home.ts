/**
 * Home page hooks: diagnostics, library flows, and the composite readiness
 * state that drives the setup/operational mode split.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchDiagnostics,
  fetchLibraryFlows,
  installLibraryFlow,
  fetchMessages,
  fetchSendingAnalytics,
  fetchLifecycleAnalytics,
  type MessagesPage,
  type SendingAnalytics,
  type LifecycleAnalytics,
} from "./api.js";
import { FLOWS_QUERY_KEY } from "./flows.js";

export const DIAGNOSTICS_QUERY_KEY = ["diagnostics"] as const;
export const LIBRARY_QUERY_KEY = ["library"] as const;
export const HOME_PENDING_QUERY_KEY = ["home", "pending"] as const;
export const HOME_FAILED_QUERY_KEY = ["home", "failed"] as const;
export const HOME_SENDING_QUERY_KEY = ["home", "sending"] as const;
export const HOME_LIFECYCLE_QUERY_KEY = ["home", "lifecycle"] as const;

/** GET /v1/diagnostics - key presence and deployment info. */
export function useDiagnostics() {
  return useQuery({
    queryKey: DIAGNOSTICS_QUERY_KEY,
    queryFn: fetchDiagnostics,
    staleTime: 60_000,
  });
}

/** GET /v1/library - available library flow sets. */
export function useLibrary() {
  return useQuery({
    queryKey: LIBRARY_QUERY_KEY,
    queryFn: fetchLibraryFlows,
  });
}

/** POST /v1/library/install - install the welcome library flow. */
export function useInstallLibrary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => installLibraryFlow(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: FLOWS_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: LIBRARY_QUERY_KEY });
    },
  });
}

/**
 * Messages pending approval - just the first page to get a count.
 * The home screen only needs "are there messages waiting?" not the full queue.
 */
export function useHomePendingMessages() {
  return useQuery({
    queryKey: HOME_PENDING_QUERY_KEY,
    queryFn: () => fetchMessages(undefined, "pending_approval"),
    refetchInterval: 30_000,
  });
}

/** Messages in failed state - count for the home screen. */
export function useHomeFailedMessages() {
  return useQuery({
    queryKey: HOME_FAILED_QUERY_KEY,
    queryFn: () => fetchMessages(undefined, "failed"),
    refetchInterval: 30_000,
  });
}

/** Sending analytics for two periods: current 7 days and prior 7 days. */
export function useHomeSending() {
  return useQuery<{ current: SendingAnalytics; prior: SendingAnalytics }>({
    queryKey: HOME_SENDING_QUERY_KEY,
    queryFn: async () => {
      const [current, prior] = await Promise.all([
        fetchSendingAnalytics(7),
        fetchSendingAnalytics(14),
      ]);
      return { current, prior };
    },
    staleTime: 60_000,
  });
}

/** Lifecycle analytics for movement detection (7 days). */
export function useHomeLifecycle() {
  return useQuery<LifecycleAnalytics>({
    queryKey: HOME_LIFECYCLE_QUERY_KEY,
    queryFn: () => fetchLifecycleAnalytics(7),
    staleTime: 60_000,
  });
}
