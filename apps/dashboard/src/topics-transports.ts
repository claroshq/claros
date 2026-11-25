/**
 * Hooks for transports with routing (Settings > Transports) and topics
 * (Settings > Topics).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchTransports,
  createTransport,
  deleteTransport,
  testTransport,
  putTransportRouting,
  fetchTopics,
  createTopic,
  patchTopic,
  type NewTransportInput,
  type TransportRouting,
  type TopicInput,
} from "./api.js";
import { TRANSPORT_QUERY_KEY } from "./settings.js";

export const TRANSPORTS_QUERY_KEY = ["settings", "transports"] as const;
export const TOPICS_QUERY_KEY = ["topics"] as const;

export function useTransports() {
  return useQuery({ queryKey: TRANSPORTS_QUERY_KEY, queryFn: fetchTransports });
}

function useInvalidateTransports() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: TRANSPORTS_QUERY_KEY });
    // The setup checklist reads the default transport.
    void qc.invalidateQueries({ queryKey: TRANSPORT_QUERY_KEY });
  };
}

export function useCreateTransport() {
  const invalidate = useInvalidateTransports();
  return useMutation({ mutationFn: (input: NewTransportInput) => createTransport(input), onSuccess: invalidate });
}

export function useDeleteTransport() {
  const invalidate = useInvalidateTransports();
  return useMutation({ mutationFn: (id: string) => deleteTransport(id), onSuccess: invalidate });
}

export function useTestTransport() {
  return useMutation({ mutationFn: ({ id, to }: { id: string; to: string }) => testTransport(id, to) });
}

export function usePutTransportRouting() {
  const invalidate = useInvalidateTransports();
  return useMutation({
    mutationFn: (routing: Partial<TransportRouting>) => putTransportRouting(routing),
    onSuccess: invalidate,
  });
}

export function useTopics() {
  return useQuery({ queryKey: TOPICS_QUERY_KEY, queryFn: fetchTopics });
}

export function useCreateTopic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TopicInput) => createTopic(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: TOPICS_QUERY_KEY }),
  });
}

export function usePatchTopic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<Omit<TopicInput, "slug">> }) => patchTopic(id, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: TOPICS_QUERY_KEY }),
  });
}
