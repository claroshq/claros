/**
 * Ingestion hooks: API key management and the first-event status poll that
 * powers the Integrate screen's waiting indicator.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchIngestKeys,
  createIngestKey,
  updateIngestKey,
  revokeIngestKey,
  fetchIngestStatus,
  type ApiKeyKind,
} from "./api.js";

export const INGEST_KEYS_QUERY_KEY = ["ingestion", "keys"] as const;
export const INGEST_STATUS_QUERY_KEY = ["ingestion", "status"] as const;

export function useIngestKeys() {
  return useQuery({ queryKey: INGEST_KEYS_QUERY_KEY, queryFn: fetchIngestKeys });
}

export function useCreateIngestKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: ApiKeyKind; label?: string; allowed_origins?: string[] }) =>
      createIngestKey(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INGEST_KEYS_QUERY_KEY });
    },
  });
}

export function useUpdateIngestKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; label?: string | null; allowed_origins?: string[] }) =>
      updateIngestKey(id, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INGEST_KEYS_QUERY_KEY });
    },
  });
}

export function useRevokeIngestKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeIngestKey(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INGEST_KEYS_QUERY_KEY });
    },
  });
}

/**
 * Poll the ingestion status. The Integrate screen enables this while it
 * waits for the first event; refetchInterval drives the "waiting" state.
 */
export function useIngestStatus(polling: boolean) {
  return useQuery({
    queryKey: INGEST_STATUS_QUERY_KEY,
    queryFn: fetchIngestStatus,
    refetchInterval: polling ? 3000 : false,
  });
}
