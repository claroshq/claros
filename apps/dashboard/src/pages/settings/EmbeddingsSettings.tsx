/**
 * Settings / Embeddings provider.
 *
 * Embeddings power semantic search over the knowledge base. They are
 * optional and have their own provider, separate from the LLM, because
 * Anthropic has no embeddings API. Without one the knowledge base is
 * searched by word matching; pinned entries and kb_select work either way.
 *
 * The effective provider may come from the LLM config (source llm_config:
 * installs whose OpenAI chat key also embeds). Saving here takes over.
 */
import React, { useState } from "react";
import { useEmbeddings, usePutEmbeddings, useDeleteEmbeddings } from "../../settings.js";
import type { EmbeddingsChange } from "../../api.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Select } from "../../components/ui/select.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Section, FormError, Notice, SummaryList, SummaryItem, errorMessage, formatDate } from "./shared.js";

const EMBEDDING_PROVIDERS: ReadonlyArray<{
  value: string;
  label: string;
  baseUrl: string | null;
  model: string | null;
  keyOptional: boolean;
}> = [
  { value: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", keyOptional: false },
  { value: "custom", label: "Custom (OpenAI-compatible)", baseUrl: null, model: null, keyOptional: true },
];

function providerLabel(value: string): string {
  return EMBEDDING_PROVIDERS.find((p) => p.value === value)?.label
    ?? ({ anthropic: "Anthropic", ollama: "Ollama" } as Record<string, string>)[value]
    ?? value;
}

function changeNote(change: EmbeddingsChange): string {
  const parts: string[] = [];
  if (change.vectors_cleared) parts.push("Stored vectors were dropped because the model changed.");
  if (change.reembed && change.reembed.enqueued > 0) {
    parts.push(
      `Re-embedding started for ${change.reembed.enqueued} ${change.reembed.enqueued === 1 ? "entry" : "entries"}` +
        (change.reembed.remaining > 0
          ? `; ${change.reembed.remaining} more wait for Retry failed embeddings on the Knowledge Base page.`
          : "."),
    );
  }
  if (!change.embeddings) parts.push("The knowledge base is now searched by word matching.");
  return parts.join(" ");
}

export default function EmbeddingsSettings() {
  const query = useEmbeddings();
  const put = usePutEmbeddings();
  const del = useDeleteEmbeddings();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (query.isLoading) return <Skeleton className="h-40 w-full" />;

  const current = query.data?.embeddings ?? null;
  const own = current?.source === "embedding_config";
  const defaults = EMBEDDING_PROVIDERS.find((p) => p.value === provider) ?? EMBEDDING_PROVIDERS[0]!;
  const isCustom = provider === "custom";
  const busy = put.isPending || del.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNote(null);
    try {
      const change = await put.mutateAsync({
        provider,
        api_key: apiKey,
        base_url: baseUrl.trim() === "" ? undefined : baseUrl.trim(),
        model: model.trim() === "" ? undefined : model.trim(),
      });
      setOpen(false);
      setApiKey("");
      setNote(`Saved. The endpoint was verified with a 1536-dimension embedding. ${changeNote(change)}`.trim());
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleRemove() {
    setError(null);
    setNote(null);
    try {
      const change = await del.mutateAsync();
      setNote(`Removed. ${changeNote(change)}`.trim());
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const formVisible = open;
  const canSubmit = (apiKey !== "" || defaults.keyOptional) && (!isCustom || (baseUrl.trim() !== "" && model.trim() !== ""));

  return (
    <Section
      title="Embeddings"
      description="Optional. Embeddings let drafts find knowledge base entries by meaning. Without them, entries are matched by shared words. Pinned entries and kb_select reach drafts either way."
      configured={null}
      actions={
        !formVisible ? (
          <div className="flex gap-2">
            {own && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={handleRemove}>
                {del.isPending ? "Removing..." : "Remove"}
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { setOpen(true); setNote(null); setError(null); }}>
              {own ? "Replace" : "Set up"}
            </Button>
          </div>
        ) : undefined
      }
    >
      {!formVisible && current && (
        <>
          <SummaryList>
            <SummaryItem label="Provider">{providerLabel(current.provider)}</SummaryItem>
            <SummaryItem label="Model" mono>{current.model ?? "unknown"}</SummaryItem>
            <SummaryItem label="Configured">{formatDate(current.created_at)}</SummaryItem>
            {current.base_url && <SummaryItem label="Endpoint" mono span>{current.base_url}</SummaryItem>}
          </SummaryList>
          {!own && (
            <p className="mt-4 text-small text-muted-foreground">
              Served by the LLM provider above with the same key. Set up a
              separate provider here to embed with a different one.
            </p>
          )}
        </>
      )}
      {!formVisible && !current && (
        <Notice variant="info">
          No embedding provider. The knowledge base is searched by word
          matching. Anthropic has no embeddings API, so with Anthropic as the
          LLM provider, semantic search needs an OpenAI key or another
          OpenAI-compatible embeddings endpoint here.
        </Notice>
      )}
      {note && !formVisible && (
        <p className="mt-3 text-small text-success" role="status">{note}</p>
      )}
      {!formVisible && <FormError message={error} />}
      {formVisible && (
        <form onSubmit={handleSubmit} noValidate className="mt-2 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="emb-provider" className="mb-1.5 block text-body font-medium text-foreground">
                Provider
              </label>
              <Select
                id="emb-provider"
                value={provider}
                onChange={(e) => { setProvider(e.target.value); setBaseUrl(""); setModel(""); }}
                disabled={busy}
              >
                {EMBEDDING_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </Select>
            </div>
            <div>
              <label htmlFor="emb-api-key" className="mb-1.5 block text-body font-medium text-foreground">
                API key{" "}
                {defaults.keyOptional ? (
                  <span className="font-normal text-muted-foreground">(optional for a local server)</span>
                ) : (
                  <span className="text-danger" aria-hidden="true">*</span>
                )}
              </label>
              <Input id="emb-api-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" disabled={busy} required={!defaults.keyOptional} />
            </div>
          </div>
          {isCustom ? (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="emb-base-url" className="mb-1.5 block text-body font-medium text-foreground">
                  Base URL <span className="text-danger" aria-hidden="true">*</span>
                </label>
                <Input id="emb-base-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your-endpoint.example.com/v1" disabled={busy} required />
              </div>
              <div>
                <label htmlFor="emb-model" className="mb-1.5 block text-body font-medium text-foreground">
                  Model <span className="text-danger" aria-hidden="true">*</span>
                </label>
                <Input id="emb-model" value={model} onChange={(e) => setModel(e.target.value)} disabled={busy} required />
              </div>
            </div>
          ) : (
            <details className="rounded-md border border-border px-3.5 py-2.5">
              <summary className="cursor-pointer text-body font-medium text-foreground">Advanced</summary>
              <div className="mt-3 grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="emb-model-adv" className="mb-1.5 block text-body font-medium text-foreground">Model</label>
                  <Input id="emb-model-adv" value={model} onChange={(e) => setModel(e.target.value)} placeholder={defaults.model ?? ""} disabled={busy} />
                </div>
                <div>
                  <label htmlFor="emb-base-url-adv" className="mb-1.5 block text-body font-medium text-foreground">Base URL</label>
                  <Input id="emb-base-url-adv" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={defaults.baseUrl ?? ""} disabled={busy} />
                </div>
              </div>
            </details>
          )}
          <p className="text-small text-muted-foreground">
            The model must return 1536-dimension vectors. Saving checks this
            with one embedding call. Changing the model re-embeds every entry.
          </p>
          <FormError message={error} />
          <div className="flex items-center gap-3 pt-1">
            <Button type="submit" disabled={busy || !canSubmit}>
              {put.isPending ? "Verifying..." : own ? "Verify and replace" : "Verify and save"}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}
