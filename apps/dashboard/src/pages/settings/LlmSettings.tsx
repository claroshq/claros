/**
 * Settings / AI providers: the LLM provider and, below it, the optional
 * embeddings provider (EmbeddingsSettings).
 *
 * The GET endpoint never returns the key, so this screen shows whether a
 * provider is configured and lets it be replaced, never what it is.
 * Without an LLM provider every flow compile returns 422.
 *
 * The embedding model used to live in this form's Advanced section; it now
 * has its own provider. PUT /v1/settings/llm still accepts embedding_model
 * for API clients (v0.6 compatibility).
 */
import React, { useState } from "react";
import { useSetupState, usePutLlm } from "../../settings.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Select } from "../../components/ui/select.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { llmDefaultsFor } from "../../llm-defaults.js";
import { Section, FormError, Notice, SummaryList, SummaryItem, errorMessage, formatDate } from "./shared.js";
import EmbeddingsSettings from "./EmbeddingsSettings.js";

const LLM_PROVIDERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "ollama", label: "Ollama" },
  { value: "custom", label: "Custom (OpenAI-compatible)" },
];

export default function LlmSettings() {
  return (
    <div className="space-y-6">
      <LlmSection />
      <EmbeddingsSettings />
    </div>
  );
}

function LlmSection() {
  const { llm, isLoading } = useSetupState();
  const put = usePutLlm();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  const defaults = llmDefaultsFor(provider);
  const isCustom = provider === "custom";
  const effectiveModel = model.trim() || defaults.model;
  const effectiveBaseUrl = baseUrl.trim() || defaults.baseUrl;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await put.mutateAsync({
        provider,
        api_key: apiKey,
        base_url: baseUrl.trim() === "" ? undefined : baseUrl.trim(),
        model: model.trim() === "" ? undefined : model.trim(),
      });
      setOpen(false);
      setSaved(true);
      setApiKey("");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const formVisible = open || llm === null;
  const canSubmit =
    (apiKey !== "" || defaults.keyOptional) &&
    (!isCustom || (effectiveBaseUrl !== null && effectiveModel !== null));

  return (
    <Section
      title="LLM provider"
      configured={llm !== null}
      actions={
        !formVisible && llm ? (
          <Button variant="outline" size="sm" onClick={() => { setOpen(true); setSaved(false); }}>
            Replace
          </Button>
        ) : undefined
      }
    >
      {!formVisible && llm && (
        <>
          <SummaryList>
            <SummaryItem label="Provider">
              {LLM_PROVIDERS.find((p) => p.value === llm.provider)?.label ?? llm.provider}
            </SummaryItem>
            <SummaryItem label="Model" mono>{llm.model ?? "default"}</SummaryItem>
            <SummaryItem label="Configured">{formatDate(llm.created_at)}</SummaryItem>
            {llm.base_url && (
              <SummaryItem label="Endpoint" mono span>{llm.base_url}</SummaryItem>
            )}
          </SummaryList>
          <p className="mt-4 text-[13px] text-muted-foreground">
            Drafts and compiles run on this provider. The key is stored encrypted and never displayed.
            {llm.provider === "anthropic" && " Anthropic has no embeddings API; for semantic knowledge base search, set up Embeddings below."}
          </p>
        </>
      )}
      {saved && !formVisible && (
        <p className="mt-3 text-[13px] text-success" role="status">
          Saved. The key was verified with the provider before storing.
        </p>
      )}
      {llm === null && (
        <Notice className="mb-4">
          Without an LLM provider every flow compile returns 422. Nothing in
          the product can draft or compile until this is set.
        </Notice>
      )}
      {formVisible && (
        <form onSubmit={handleSubmit} noValidate className="mt-2 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="llm-provider" className="mb-1.5 block text-[14px] font-medium text-foreground">
                Provider
              </label>
              <Select
                id="llm-provider"
                value={provider}
                onChange={(e) => { setProvider(e.target.value); setBaseUrl(""); setModel(""); }}
                disabled={put.isPending}
              >
                {LLM_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </Select>
            </div>
            <div>
              <label htmlFor="llm-api-key" className="mb-1.5 block text-[14px] font-medium text-foreground">
                API key{" "}
                {defaults.keyOptional ? (
                  <span className="font-normal text-muted-foreground">(optional for a local install)</span>
                ) : (
                  <span className="text-danger" aria-hidden="true">*</span>
                )}
              </label>
              <Input id="llm-api-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" disabled={put.isPending} required={!defaults.keyOptional} />
            </div>
          </div>
          {isCustom && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="llm-base-url" className="mb-1.5 block text-[14px] font-medium text-foreground">
                  Base URL <span className="text-danger" aria-hidden="true">*</span>
                </label>
                <Input id="llm-base-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your-endpoint.example.com/v1" disabled={put.isPending} required />
              </div>
              <div>
                <label htmlFor="llm-model" className="mb-1.5 block text-[14px] font-medium text-foreground">
                  Model <span className="text-danger" aria-hidden="true">*</span>
                </label>
                <Input id="llm-model" value={model} onChange={(e) => setModel(e.target.value)} disabled={put.isPending} required />
              </div>
            </div>
          )}
          {!isCustom && effectiveModel !== null && effectiveBaseUrl !== null && (
            <p className="text-[14px] text-muted-foreground">
              Claros will use <span className="font-mono text-[13px]">{effectiveModel}</span>
              {" via "}
              <span className="font-mono text-[13px]">{effectiveBaseUrl}</span>.
            </p>
          )}
          {!isCustom && (
            <details className="rounded-md border border-border px-3.5 py-2.5">
              <summary className="cursor-pointer text-[14px] font-medium text-foreground">
                Advanced
              </summary>
              <p className="mt-2 text-[14px] text-muted-foreground">
                The defaults work for almost everyone. Only change these if you
                know why.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="llm-model-adv" className="mb-1.5 block text-[14px] font-medium text-foreground">
                    Model
                  </label>
                  <Input
                    id="llm-model-adv"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={defaults.model ?? ""}
                    disabled={put.isPending}
                  />
                </div>
                <div>
                  <label htmlFor="llm-base-url-adv" className="mb-1.5 block text-[14px] font-medium text-foreground">
                    Base URL
                  </label>
                  <Input
                    id="llm-base-url-adv"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={defaults.baseUrl ?? ""}
                    disabled={put.isPending}
                  />
                </div>
              </div>
            </details>
          )}
          <FormError message={error} />
          <div className="flex items-center gap-3 pt-1">
            <Button type="submit" disabled={put.isPending || !canSubmit}>
              {put.isPending ? "Verifying..." : llm === null ? "Verify and save" : "Verify and replace"}
            </Button>
            {llm !== null && (
              <Button type="button" variant="ghost" disabled={put.isPending} onClick={() => setOpen(false)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
    </Section>
  );
}
