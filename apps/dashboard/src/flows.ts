/**
 * Flows query hooks and mutations.
 *
 * Follows the same pattern as auth.ts / useMe(): thin wrappers over
 * TanStack Query that page components call directly.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchFlows,
  fetchFlow,
  fetchEventNames,
  createFlow,
  updateFlow,
  compileFlow,
  archiveFlow,
  saveFlowPlan,
  saveFlowSteps,
  draftFlowStep,
  type CreateFlowInput,
  type UpdateFlowInput,
  type DraftStepInput,
} from "./api.js";

export const FLOWS_QUERY_KEY = ["flows"] as const;

export function flowQueryKey(id: string) {
  return ["flows", id] as const;
}

/** Fetch the flows list for the current tenant. */
export function useFlows() {
  return useQuery({
    queryKey: FLOWS_QUERY_KEY,
    queryFn: fetchFlows,
  });
}

/**
 * Fetch a single flow with compile-aware polling.
 *
 * Polling guarantee: refetchInterval is a function. It returns 3000 when
 * compile_status is 'pending' and false otherwise. TanStack Query stops the
 * interval when the component unmounts because the query is removed from the
 * cache (no active observer). It does not start for flows that are not pending
 * because the function returns false on the first evaluation.
 *
 * The interval is defined here, colocated with the query, not in the
 * component. staleTime is overridden to 0 so the cache never serves a stale
 * value while polling is active.
 */
export function useFlowWithPolling(id: string) {
  return useQuery({
    queryKey: flowQueryKey(id),
    queryFn: () => fetchFlow(id),
    staleTime: 0,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.compile_status === "pending" ? 3000 : false;
    },
  });
}

/** Create a new flow. Invalidates the flows list on success. */
export function useCreateFlow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFlowInput) => createFlow(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: FLOWS_QUERY_KEY });
    },
  });
}

/**
 * Fetch distinct recent event names for the event-trigger autosuggest in
 * the flow editor. Advisory list; any string remains a valid event name.
 */
export function useEventNames() {
  return useQuery({
    queryKey: ["events", "names"],
    queryFn: fetchEventNames,
    staleTime: 60_000,
  });
}

/** Update an existing flow. Invalidates both list and single-flow queries on success. */
export function useUpdateFlow(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateFlowInput) => updateFlow(id, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: FLOWS_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: flowQueryKey(id) });
    },
  });
}

/**
 * Enqueue a compile job for a flow. On success, invalidates the single-flow
 * query so the editor immediately shows compile_status = 'pending' and
 * useFlowWithPolling begins polling.
 */
export function useCompileFlow(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => compileFlow(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: flowQueryKey(id) });
    },
  });
}

/**
 * Change a flow's status (activate, pause). The server validates the
 * transition: draft|paused -> active requires compile_status = 'ready' and
 * a compiled plan; archived is terminal. 422 and 409 surface as
 * FlowApiError and are rendered verbatim.
 */
export function useFlowStatus(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status: "active" | "paused") => updateFlow(id, { status }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: FLOWS_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: flowQueryKey(id) });
    },
  });
}

/**
 * Archive a flow (DELETE). Archived is terminal; the UI confirms before
 * calling this. Invalidates the list; callers navigate away from the editor.
 */
export function useArchiveFlow(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => archiveFlow(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: FLOWS_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: flowQueryKey(id) });
    },
  });
}

/**
 * Save a hand-authored compiled plan for a fixed_content flow.
 * On success, the flow becomes compile_status = 'ready' and can be activated.
 */
export function useSaveFlowPlan(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (plan: Record<string, unknown>) => saveFlowPlan(id, plan),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: FLOWS_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: flowQueryKey(id) });
    },
  });
}

/**
 * Ask the AI to draft copy for a single step. Returns subject + body_html.
 * The result is never stored automatically - the person edits it first.
 */
export function useDraftFlowStep(id: string) {
  return useMutation({
    mutationFn: (input: DraftStepInput) => draftFlowStep(id, input),
  });
}

/**
 * Save the plan as explicit steps (PUT /v1/flows/:id/steps). On success the
 * flow has compile_status = 'ready' with exactly these steps.
 */
export function useSaveFlowSteps(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (plan: { steps: Record<string, unknown>[]; exit_conditions?: unknown[] }) => saveFlowSteps(id, plan),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: FLOWS_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: flowQueryKey(id) });
    },
  });
}
