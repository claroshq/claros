/**
 * Settings hooks: transport, LLM provider, tenant (postal address + brand),
 * business model templates, and test email. Also exports useSetupState, the
 * combined read behind the first-run checklist.
 */
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchTransport,
  putTransport,
  fetchLlm,
  putLlm,
  fetchEmbeddings,
  putEmbeddings,
  deleteEmbeddings,
  fetchTenant,
  patchTenant,
  sendTestEmail,
  fetchBrandLogo,
  uploadBrandLogo,
  deleteBrandLogo,
  fetchTemplates,
  applyTemplate,
  fetchThrottle,
  putThrottle,
  type TransportInput,
  type LlmInput,
  type EmbeddingsInput,
  type BrandSettingsData,
  type ThrottleInput,
} from "./api.js";
import { FLOWS_QUERY_KEY } from "./flows.js";
import { KB_QUERY_KEY } from "./kb.js";

export const TRANSPORT_QUERY_KEY = ["settings", "transport"] as const;
export const LLM_QUERY_KEY = ["settings", "llm"] as const;
export const EMBEDDINGS_QUERY_KEY = ["settings", "embeddings"] as const;
export const TENANT_QUERY_KEY = ["settings", "tenant"] as const;
export const TEMPLATES_QUERY_KEY = ["templates"] as const;

export function useTransport() {
  return useQuery({ queryKey: TRANSPORT_QUERY_KEY, queryFn: fetchTransport });
}

export function useLlm() {
  return useQuery({ queryKey: LLM_QUERY_KEY, queryFn: fetchLlm });
}

export function useTenant() {
  return useQuery({ queryKey: TENANT_QUERY_KEY, queryFn: fetchTenant });
}

export function usePutTransport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TransportInput) => putTransport(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TRANSPORT_QUERY_KEY });
    },
  });
}

export function usePutLlm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LlmInput) => putLlm(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LLM_QUERY_KEY });
      // The chat config can serve embeddings (source llm_config).
      void qc.invalidateQueries({ queryKey: EMBEDDINGS_QUERY_KEY });
    },
  });
}

export function useEmbeddings() {
  return useQuery({ queryKey: EMBEDDINGS_QUERY_KEY, queryFn: fetchEmbeddings });
}

function useEmbeddingsMutation<A>(fn: (a: A) => ReturnType<typeof putEmbeddings>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: EMBEDDINGS_QUERY_KEY });
      // Entries change state: vectors cleared, re-embedding queued.
      void qc.invalidateQueries({ queryKey: KB_QUERY_KEY });
    },
  });
}

export function usePutEmbeddings() {
  return useEmbeddingsMutation((input: EmbeddingsInput) => putEmbeddings(input));
}

export function useDeleteEmbeddings() {
  return useEmbeddingsMutation((_: void) => deleteEmbeddings());
}

export function usePatchTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { postal_address?: string; brand?: Partial<BrandSettingsData> }) =>
      patchTenant(payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TENANT_QUERY_KEY });
    },
  });
}

export const BRAND_LOGO_QUERY_KEY = ["settings", "brand-logo"] as const;

export function useBrandLogo() {
  return useQuery({ queryKey: BRAND_LOGO_QUERY_KEY, queryFn: fetchBrandLogo });
}

/** Upload or remove the brand logo; both change brand.logo_url, so the tenant is refetched too. */
export function useBrandLogoMutations() {
  const qc = useQueryClient();
  const onSuccess = () => {
    void qc.invalidateQueries({ queryKey: BRAND_LOGO_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: TENANT_QUERY_KEY });
  };
  return {
    upload: useMutation({ mutationFn: (file: File) => uploadBrandLogo(file), onSuccess }),
    remove: useMutation({ mutationFn: () => deleteBrandLogo(), onSuccess }),
  };
}

export function useSendTestEmail() {
  return useMutation({
    mutationFn: (to: string) => sendTestEmail(to),
  });
}

export const THROTTLE_QUERY_KEY = ["settings", "throttle"] as const;

export function useThrottle() {
  return useQuery({ queryKey: THROTTLE_QUERY_KEY, queryFn: fetchThrottle });
}

export function usePutThrottle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ThrottleInput) => putThrottle(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: THROTTLE_QUERY_KEY });
    },
  });
}

export function useTemplates() {
  return useQuery({ queryKey: TEMPLATES_QUERY_KEY, queryFn: fetchTemplates });
}

export function useApplyTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => applyTemplate(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: FLOWS_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: TENANT_QUERY_KEY });
    },
  });
}

/**
 * The three reads that define "is this install able to do anything":
 * LLM provider (compilation), transport (sending), postal address
 * (CAN-SPAM, blocks the drain). Used by the first-run checklist and by
 * Settings itself.
 */
export function useSetupState() {
  const [llm, transport, tenant] = useQueries({
    queries: [
      { queryKey: LLM_QUERY_KEY, queryFn: fetchLlm },
      { queryKey: TRANSPORT_QUERY_KEY, queryFn: fetchTransport },
      { queryKey: TENANT_QUERY_KEY, queryFn: fetchTenant },
    ],
  });

  const isLoading = llm.isLoading || transport.isLoading || tenant.isLoading;
  const isError = llm.isError || transport.isError || tenant.isError;

  const checks = {
    llm: llm.data?.llm !== null && llm.data !== undefined,
    transport: transport.data?.transport !== null && transport.data !== undefined,
    postalAddress:
      tenant.data !== undefined && (tenant.data.tenant.postal_address ?? "") !== "",
  };

  return {
    isLoading,
    isError,
    checks,
    complete: checks.llm && checks.transport && checks.postalAddress,
    llm: llm.data?.llm ?? null,
    transport: transport.data?.transport ?? null,
    tenant: tenant.data?.tenant ?? null,
  };
}
