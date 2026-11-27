/**
 * Connect your AI: the MCP server, set up from the dashboard.
 *
 * The job is to get an operator from "what is this" to a first answer in
 * their own assistant: what it does and what it never does, three steps
 * (create a key with the right scopes, paste one snippet for the picked
 * client with the endpoint and the new key already filled in, ask a first
 * question), prompts that map onto the released tools, and the keys that
 * can work the queue today. Everything stated here is in docs/guide/MCP.md.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Check, Copy, KeyRound, Lock, MessageSquare, ShieldCheck, Terminal } from "lucide-react";
import { PageHeader } from "../../components/page-header.js";
import { CodeBlock, useCopy } from "../../components/code-block.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { cn } from "../../lib/utils.js";
import { useCreateIngestKey, useIngestKeys } from "../../ingestion.js";
import type { CreatedIngestKey } from "../../api.js";
import { ago } from "../../lib/time.js";
import { CLIENTS, MCP_SCOPES, PROMPTS, mcpKeyState, mcpKeys, type ClientId } from "./mcp.js";

const KEY_PLACEHOLDER = "clr_ak_...";

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="relative flex gap-4 pb-8 last:pb-0">
      <span
        aria-hidden="true"
        className="absolute left-[13px] top-8 bottom-0 w-px bg-border [li:last-child>&]:hidden"
      />
      <span
        className={cn(
          "relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-[14px] font-semibold",
          done ? "bg-success-soft text-success" : "bg-accent-soft text-accent-text",
        )}
      >
        {done ? <Check size={14} strokeWidth={2.5} /> : n}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <h3 className="text-[17px] font-semibold text-foreground">
          {title}
          {done && <span className="sr-only"> (done)</span>}
        </h3>
        <div className="mt-2 space-y-3">{children}</div>
      </div>
    </li>
  );
}

function KeyStep({
  created,
  onCreated,
  hasKey,
}: {
  created: CreatedIngestKey | null;
  onCreated: (k: CreatedIngestKey) => void;
  hasKey: boolean;
}) {
  const create = useCreateIngestKey();
  const [withConfig, setWithConfig] = useState(false);
  const [label, setLabel] = useState("MCP: approvals");
  const { copied, copy } = useCopy();

  if (created) {
    return (
      <div role="status" className="rounded-md border border-success bg-success-soft p-4">
        <p className="text-[16px] font-medium text-foreground">Admin key created</p>
        <p className="mt-1 text-[15px] text-foreground">
          It is already in the snippet below. Copy it now if you need it elsewhere: it is stored as a hash and never
          shown again.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <code className="break-all rounded-md bg-card px-3 py-2 font-mono text-[14px] text-foreground">
            {created.key}
          </code>
          <Button variant="secondary" size="sm" onClick={() => copy("key", created.key)}>
            {copied === "key" ? <Check size={16} strokeWidth={1.5} /> : <Copy size={16} strokeWidth={1.5} />}
            {copied === "key" ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>
    );
  }

  const scopes = withConfig ? [...MCP_SCOPES, "config"] : [...MCP_SCOPES];
  return (
    <>
      <p className="text-[15px] leading-[24px] text-muted-foreground">
        The assistant signs in with a product admin key. The key decides the product and which tools the assistant
        sees.{" "}
        {hasKey
          ? "You already have one with the messages scope (listed at the bottom); create a new one per person or client so you can revoke them separately."
          : "Owners create keys."}
      </p>
      <div className="rounded-md border border-border bg-secondary p-4">
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {MCP_SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-2 text-[15px] text-foreground">
              <input type="checkbox" checked disabled className="h-4 w-4 accent-(--accent-deep)" />
              <span className="font-mono">{s}</span>
            </label>
          ))}
          <label className="flex items-center gap-2 text-[15px] text-foreground">
            <input
              type="checkbox"
              checked={withConfig}
              onChange={(e) => setWithConfig(e.target.checked)}
              className="h-4 w-4 accent-(--accent-deep)"
            />
            <span className="font-mono">config</span>
            <span className="text-muted-foreground">pause and resume flows</span>
          </label>
        </div>
        {withConfig && (
          <p className="mt-2 text-[14px] text-muted-foreground">
            config also allows PUT /v1/config over the HTTP API. Give it deliberately.
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-label="Key label"
            className="h-8 w-64 rounded-md border border-border-strong bg-background px-2.5 text-[15px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button
            size="sm"
            disabled={create.isPending}
            onClick={() =>
              create.mutate(
                { kind: "admin", label: label.trim() || undefined, scopes },
                { onSuccess: (k) => onCreated(k) },
              )
            }
          >
            <KeyRound size={16} strokeWidth={1.5} />
            Create admin key
          </Button>
        </div>
        {create.isError && (
          <p className="mt-2 text-[15px] text-danger">
            {create.error instanceof Error ? create.error.message : "Could not create the key."} Only product owners
            can create admin keys.
          </p>
        )}
      </div>
    </>
  );
}

function ClientStep({ endpoint, rawKey }: { endpoint: string; rawKey: string | null }) {
  const [clientId, setClientId] = useState<ClientId>("claude-code");
  const client = CLIENTS.find((c) => c.id === clientId)!;
  const key = rawKey ?? KEY_PLACEHOLDER;
  return (
    <>
      <div role="tablist" aria-label="MCP client" className="flex flex-wrap gap-2">
        {CLIENTS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={c.id === clientId}
            onClick={() => setClientId(c.id)}
            className={cn(
              "flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors duration-(--dur-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              c.id === clientId
                ? "border-accent bg-accent-soft"
                : "border-border bg-card hover:bg-hover",
            )}
          >
            <span className="text-[15px] font-medium text-foreground">{c.name}</span>
            <span className="text-[14px] text-muted-foreground">{c.where}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" className="space-y-2">
        <p className="text-[15px] text-foreground">{client.intro}</p>
        <CodeBlock id={`mcp-${client.id}`} code={client.snippet(endpoint, key)} />
        {!rawKey && (
          <p className="text-[14px] text-muted-foreground">
            Replace <code className="font-mono">{KEY_PLACEHOLDER}</code> with your admin key, or create one in step 1
            and it is filled in here.
          </p>
        )}
        <p className="text-[14px] leading-[22px] text-muted-foreground">{client.after}</p>
      </div>
    </>
  );
}

function PromptList({ scopes }: { scopes: Set<string> | null }) {
  const { copied, copy } = useCopy();
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {PROMPTS.map((p, i) => {
        const missing = scopes !== null && !scopes.has(p.scope);
        return (
          <li key={p.text} className="flex flex-col rounded-lg border border-border bg-card shadow-card p-4">
            <p className="text-[16px] leading-[23px] text-foreground">"{p.text}"</p>
            <div className="mt-auto flex items-center gap-2 pt-3">
              <span className="truncate font-mono text-[14px] text-subtle-foreground">{p.uses}</span>
              {missing && (
                <span className="inline-flex shrink-0 items-center gap-1 text-[14px] text-muted-foreground">
                  <Lock size={12} /> needs {p.scope}
                </span>
              )}
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => copy(`p${i}`, p.text)}>
                {copied === `p${i}` ? <Check size={14} strokeWidth={1.5} /> : <Copy size={14} strokeWidth={1.5} />}
                {copied === `p${i}` ? "Copied" : "Copy"}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const GUARANTEES = [
  {
    icon: ShieldCheck,
    title: "Same rules as the dashboard",
    text: "An approved draft goes out through the normal drain: send window, throttle, suppression and consent still apply.",
  },
  {
    icon: Lock,
    title: "Nothing sent, configured or deleted",
    text: "No test sends, no flow or prompt edits, no deletes. The LLM never runs in the MCP server.",
  },
  {
    icon: KeyRound,
    title: "One key, one product",
    text: "The key decides the product and the tools. Every approval records the key; revoke it on the Integrate page.",
  },
];

export default function ConnectAiPage() {
  const keys = useIngestKeys();
  const [created, setCreated] = useState<CreatedIngestKey | null>(null);
  const endpoint = `${window.location.origin}/v1/mcp`;
  const allKeys = keys.data?.keys ?? [];
  const state = mcpKeyState(allKeys);
  const usable = mcpKeys(allKeys);
  const { copied, copy } = useCopy();

  // Prompts are marked by what the newest usable key (or the one just made) can do.
  const scopes = useMemo(() => {
    if (created) return new Set(created.scopes ?? []);
    if (usable.length === 0) return null;
    return new Set(usable.flatMap((k) => k.scopes ?? []));
  }, [created, usable]);

  return (
    <div className="mx-auto max-w-[90rem]">
      <PageHeader
        eyebrow="Integrate"
        title="Connect your AI"
        subtitle="Work the approval queue from Claude Code, Claude Desktop or any MCP client, without opening the dashboard."
        actions={
          <a
            href="https://github.com/claroshq/claros/blob/main/docs/guide/MCP.md"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[15px] text-accent-text"
          >
            MCP guide <ArrowUpRight size={12} />
          </a>
        }
      />

      <section className="rounded-lg border border-border bg-card shadow-card p-6">
        <div className="flex flex-col gap-6 lg:flex-row">
          <div className="min-w-0 flex-1">
            {keys.isLoading ? (
              <Skeleton className="h-6 w-40" />
            ) : state.kind === "used" ? (
              <Badge variant="success">Admin key used {ago(state.lastUsedAt)}</Badge>
            ) : state.kind === "ready" ? (
              <Badge variant="accent">Key ready, ask your first question</Badge>
            ) : (
              <Badge variant="muted">Not set up, about two minutes</Badge>
            )}
            <h2 className="mt-3 font-display text-[22px] font-bold leading-[30px] tracking-[-0.02em] text-foreground">
              "Anything waiting in Claros?"
            </h2>
            <p className="mt-2 max-w-xl text-[16px] leading-[24px] text-muted-foreground">
              Claros serves a Model Context Protocol endpoint as part of the API you already run. Your assistant reads
              the queue with each draft's flow, subject and reasoning, and approves, edits, revises or rejects on your
              word. Nothing extra to install on the server.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <code className="rounded-md bg-sunken px-3 py-1.5 font-mono text-[14px] text-foreground">{endpoint}</code>
              <Button variant="secondary" size="sm" onClick={() => copy("endpoint", endpoint)}>
                {copied === "endpoint" ? <Check size={16} strokeWidth={1.5} /> : <Copy size={16} strokeWidth={1.5} />}
                {copied === "endpoint" ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
          <ul className="grid gap-4 lg:w-[340px]">
            {GUARANTEES.map((g) => {
              const Icon = g.icon;
              return (
                <li key={g.title} className="flex gap-3">
                  <Icon size={16} strokeWidth={1.5} className="mt-0.5 shrink-0 text-accent-text" />
                  <div>
                    <p className="text-[15px] font-medium text-foreground">{g.title}</p>
                    <p className="mt-0.5 text-[14px] leading-[22px] text-muted-foreground">{g.text}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="mb-5 flex items-center gap-2 text-[22px] font-semibold leading-[30px] tracking-[-0.015em] text-foreground">
          <Terminal size={18} strokeWidth={1.5} className="text-accent-text" />
          Set it up
        </h2>
        <ol>
          <Step n={1} title="Create an admin key" done={created !== null}>
            <KeyStep created={created} onCreated={setCreated} hasKey={usable.length > 0} />
          </Step>
          <Step n={2} title="Add Claros to your client" done={false}>
            <ClientStep endpoint={endpoint} rawKey={created?.key ?? null} />
          </Step>
          <Step n={3} title="Ask your first question" done={state.kind === "used"}>
            <p className="text-[15px] leading-[24px] text-muted-foreground">
              Start a new chat and ask "Anything waiting in Claros?". The assistant calls queue_summary and answers
              with the counts. {state.kind === "used" ? "" : "Once it does, this page shows when the key was last used."}
            </p>
          </Step>
        </ol>
      </section>

      <section className="mt-10">
        <h2 className="mb-1 flex items-center gap-2 text-[22px] font-semibold leading-[30px] tracking-[-0.015em] text-foreground">
          <MessageSquare size={18} strokeWidth={1.5} className="text-accent-text" />
          What to ask
        </h2>
        <p className="mb-4 text-[15px] text-muted-foreground">
          Plain words work. Each prompt shows the tools it ends up calling.
        </p>
        <PromptList scopes={scopes} />
      </section>

      <section className="mt-10">
        <h2 className="mb-4 text-[22px] font-semibold leading-[30px] tracking-[-0.015em] text-foreground">
          Keys that can review
        </h2>
        {keys.isLoading ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : usable.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border-strong px-5 py-4 text-[15px] text-muted-foreground">
            No admin key with the messages scope yet. Step 1 creates one.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card shadow-card">
            {usable.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                <span className="font-mono text-[14px] text-muted-foreground">{k.prefix}...</span>
                <span className="text-[15px] text-foreground">{k.label ?? "No label"}</span>
                <span className="font-mono text-[14px] text-subtle-foreground">{(k.scopes ?? []).join(", ")}</span>
                <span className="ml-auto font-mono text-[14px] text-muted-foreground">
                  {k.last_used_at ? `used ${ago(k.last_used_at)}` : "never used"}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[14px] text-muted-foreground">
          Revoke keys on the <Link to="/integrate" className="text-accent-text">Integrate</Link> page; revocation
          applies to the next request. Last used covers every call made with the key, MCP or HTTP API.
        </p>
      </section>
    </div>
  );
}
