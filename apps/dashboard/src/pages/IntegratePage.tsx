/**
 * Integrate page.
 *
 * The activation path for a fresh install: get a key, paste the snippet,
 * watch the first event arrive. It stays useful afterwards as the place to
 * manage keys and confirm events are still arriving.
 *
 * Sections:
 *   1. First event indicator - polls /v1/ingestion/status every 3s while no
 *      event has arrived; flips to a received state showing what arrived.
 *   2. Browser snippet - the two-stub + claros.js snippet with the tenant's
 *      publishable key already interpolated. Creates a publishable key
 *      inline when none exists.
 *   3. API keys - list, create (publishable / secret), edit origins, revoke.
 *      The raw key is shown exactly once, in the creation banner.
 */
import { Fragment, useMemo, useState, type ElementType } from "react";
import { Check, Copy, Plus, X, Zap, Code2, KeyRound, Send } from "lucide-react";
import {
  useIngestKeys,
  useCreateIngestKey,
  useUpdateIngestKey,
  useRevokeIngestKey,
  useIngestStatus,
} from "../ingestion.js";
import type { CreatedIngestKey, IngestKey } from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { PageHeader } from "../components/page-header.js";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "../components/ui/table.js";
import { useMe } from "../auth.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function useCopy(): { copied: string | null; copy: (id: string, text: string) => void } {
  const [copied, setCopied] = useState<string | null>(null);
  function copy(id: string, text: string) {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    });
  }
  return { copied, copy };
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

// ---------------------------------------------------------------------------
// First event indicator
// ---------------------------------------------------------------------------

function SectionHeading({
  icon: Icon,
  title,
}: {
  icon: ElementType;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-text">
        <Icon size={16} strokeWidth={1.5} />
      </span>
      <h2 className="text-[20px] font-semibold leading-[28px] tracking-[-0.015em] text-foreground">
        {title}
      </h2>
    </div>
  );
}

function FirstEventCard() {
  const { data: status, isLoading } = useIngestStatus(true);
  const waiting = !status?.last_event;

  return (
    <section className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-center justify-between">
        <SectionHeading icon={Zap} title="Your first event" />
        {isLoading ? (
          <Skeleton className="h-6 w-28 rounded-full" />
        ) : waiting ? (
          <Badge variant="warning" pulse>
            Waiting for events
          </Badge>
        ) : (
          <Badge variant="success">Receiving events</Badge>
        )}
      </div>

      {isLoading ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-40" />
        </div>
      ) : waiting ? (
        <p className="mt-3 text-[14px] text-muted-foreground">
          Send an event with the snippet or curl command below. This panel
          checks every few seconds and confirms the moment one arrives.
        </p>
      ) : (
        <div className="mt-4 space-y-2">
          <p className="text-[14px] text-muted-foreground">
            Latest event received. Your integration is working.
          </p>
          <dl className="grid grid-cols-[96px_1fr] gap-y-1.5 text-[14px]">
            <dt className="text-muted-foreground">Type</dt>
            <dd className="font-mono text-[13px] text-foreground">{status.last_event!.type}</dd>
            {status.last_event!.event_name && (
              <>
                <dt className="text-muted-foreground">Event</dt>
                <dd className="font-mono text-[13px] text-foreground">{status.last_event!.event_name}</dd>
              </>
            )}
            <dt className="text-muted-foreground">User</dt>
            <dd className="font-mono text-[13px] text-foreground">{status.last_event!.user_id}</dd>
            <dt className="text-muted-foreground">Received</dt>
            <dd className="font-mono text-[13px] text-foreground">
              {formatTimestamp(status.last_event!.received_at)}
            </dd>
            <dt className="text-muted-foreground">Last 24h</dt>
            <dd className="font-mono text-[13px] text-foreground">
              {status.events_last_24h} {status.events_last_24h === 1 ? "event" : "events"}
            </dd>
          </dl>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Browser snippet
// ---------------------------------------------------------------------------

function buildSnippet(origin: string, rawKey: string | null): string {
  const k = rawKey ?? "PASTE_YOUR_PUBLISHABLE_KEY";
  return [
    "<script>",
    "  window.claros = window.claros || function () {",
    "    (window.claros.q = window.claros.q || []).push(arguments);",
    "  };",
    "</script>",
    `<script async src="${origin}/claros.js"></script>`,
    "<script>",
    `  claros("init", "${k}", { endpoint: "${origin}" });`,
    '  claros("identify", "user_123", { email: "user@example.com" });',
    '  claros("track", "signed_up");',
    "</script>",
  ].join("\n");
}

function buildCurl(origin: string): string {
  return [
    `curl -X POST ${origin}/v1/track \\`,
    '  -H "Authorization: Bearer PASTE_YOUR_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"userId": "user_123", "event": "signed_up"}'`,
  ].join("\n");
}

function CodeBlock({ id, code }: { id: string; code: string }) {
  const { copied, copy } = useCopy();
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md bg-sunken p-4 font-mono text-[13px] leading-5 text-foreground">
        {code}
      </pre>
      <Button
        variant="secondary"
        size="sm"
        className="absolute right-3 top-3"
        onClick={() => copy(id, code)}
      >
        {copied === id ? (
          <Check size={16} strokeWidth={1.5} />
        ) : (
          <Copy size={16} strokeWidth={1.5} />
        )}
        {copied === id ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function SnippetCard({ publishableKey, rawKey, onCreateKey, creating }: {
  publishableKey: IngestKey | null;
  /** Raw value of a publishable key created this session (shown once). */
  rawKey: string | null;
  onCreateKey: () => void;
  creating: boolean;
}) {
  const origin = window.location.origin;
  const snippet = useMemo(() => buildSnippet(origin, rawKey), [origin, rawKey]);
  const curl = useMemo(() => buildCurl(origin), [origin]);

  return (
    <section className="rounded-lg border border-border bg-card p-6">
      <SectionHeading icon={Code2} title="Browser snippet" />
      <p className="mt-1 text-[14px] text-muted-foreground">
        Paste this into your site's HTML, before the closing body tag. It
        identifies a user and tracks an event.
      </p>

      {publishableKey === null ? (
        <div className="mt-4 rounded-md border border-dashed border-border-strong p-4">
          <p className="text-[14px] text-muted-foreground">
            You need a publishable key first. Publishable keys are safe to
            embed in a web page: they can write events and nothing else.
          </p>
          <Button size="sm" className="mt-3" onClick={onCreateKey} disabled={creating}>
            <Plus size={16} strokeWidth={1.5} />
            {creating ? "Creating..." : "Create publishable key"}
          </Button>
        </div>
      ) : (
        <>
          <div className="mt-4">
            <CodeBlock id="snippet" code={snippet} />
          </div>
          <p className="mt-3 text-[14px] text-muted-foreground">
            The snippet sends events without a CORS preflight and survives
            page unloads. It can only write events, never read your data.
          </p>
          {!rawKey && publishableKey && (
            <p className="mt-2 text-[14px] text-muted-foreground">
              Paste the publishable key you saved at creation (
              <span className="font-mono text-[13px]">{publishableKey.prefix}...</span>
              ) into the init line, or create a new publishable key below to
              get a snippet with the key already in it.
            </p>
          )}
          <p className="mt-5 text-[14px] font-medium text-foreground">
            Or send one with curl
          </p>
          <div className="mt-2">
            <CodeBlock id="curl" code={curl} />
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Key creation banner (raw key shown once)
// ---------------------------------------------------------------------------

function CreatedKeyBanner({ created, onDismiss }: { created: CreatedIngestKey; onDismiss: () => void }) {
  const { copied, copy } = useCopy();
  return (
    <div className="rounded-md border border-success bg-success-soft p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[14px] font-medium text-foreground">
            {created.kind === "publishable" ? "Publishable" : "Secret"} key created
          </p>
          <p className="mt-1 text-[14px] text-foreground">
            Copy it now. For your security it is stored as a hash and will
            never be shown again.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="rounded-md bg-card px-3 py-2 font-mono text-[13px] text-foreground">
              {created.key}
            </code>
            <Button variant="secondary" size="sm" onClick={() => copy("newkey", created.key)}>
              {copied === "newkey" ? (
                <Check size={16} strokeWidth={1.5} />
              ) : (
                <Copy size={16} strokeWidth={1.5} />
              )}
              {copied === "newkey" ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--dur-fast) hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X size={16} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Origin allowlist editor (per publishable key row)
// ---------------------------------------------------------------------------

function OriginsEditor({ apiKey }: { apiKey: IngestKey }) {
  const update = useUpdateIngestKey();
  const [text, setText] = useState(apiKey.allowed_origins.join("\n"));

  function save() {
    const origins = text
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    update.mutate(
      { id: apiKey.id, allowed_origins: origins },
      {
        onError: () => {
          /* surfaced via update.error below */
        },
      },
    );
  }

  return (
    <div className="py-2">
      <label
        htmlFor={`origins-${apiKey.id}`}
        className="mb-1.5 block text-[14px] font-medium text-foreground"
      >
        Allowed origins
      </label>
      <p className="mb-2 text-[14px] text-muted-foreground">
        One origin per line, for example https://app.example.com. Browsers on
        other origins are rejected. Leave empty to allow any origin.
      </p>
      <textarea
        id={`origins-${apiKey.id}`}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="https://app.example.com"
        className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[13px] text-foreground placeholder:text-subtle-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {update.isError && (
        <p className="mt-2 text-[14px] text-danger">
          {update.error instanceof Error ? update.error.message : "Could not save origins."}
        </p>
      )}
      <div className="mt-2">
        <Button size="sm" variant="secondary" onClick={save} disabled={update.isPending}>
          {update.isPending ? "Saving..." : "Save origins"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Keys table
// ---------------------------------------------------------------------------

function KeysCard({ keys, onCreated }: { keys: IngestKey[]; onCreated: (k: CreatedIngestKey) => void }) {
  const create = useCreateIngestKey();
  const revoke = useRevokeIngestKey();
  const [editingId, setEditingId] = useState<string | null>(null);

  function createKey(kind: "publishable" | "secret") {
    create.mutate(
      { kind },
      { onSuccess: (created) => onCreated(created) },
    );
  }

  return (
    <section className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-start justify-between">
        <div>
          <SectionHeading icon={KeyRound} title="API keys" />
          <p className="mt-1 text-[14px] text-muted-foreground">
            Publishable keys go in web pages. Secret keys go in your backend
            and never in browser code.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => createKey("publishable")}
            disabled={create.isPending}
          >
            <Plus size={16} strokeWidth={1.5} />
            Publishable key
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => createKey("secret")}
            disabled={create.isPending}
          >
            <Plus size={16} strokeWidth={1.5} />
            Secret key
          </Button>
        </div>
      </div>

      {create.isError && (
        <p className="mt-3 text-[14px] text-danger">
          {create.error instanceof Error ? create.error.message : "Could not create the key."}
        </p>
      )}

      {keys.length === 0 ? (
        <p className="mt-6 text-[14px] text-muted-foreground">
          No keys yet. Create a publishable key for the browser snippet, or a
          secret key for server-side sending.
        </p>
      ) : (
        <div className="mt-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Origins</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((k) => (
                <Fragment key={k.id}>
                  <TableRow>
                    <TableCell className="font-mono text-[13px] text-muted-foreground">
                      {k.prefix}...
                    </TableCell>
                    <TableCell>
                      <Badge variant={k.kind === "publishable" ? "accent" : "neutral"}>
                        {k.kind}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-[14px] text-foreground">
                      {k.label ?? <span className="text-subtle-foreground">-</span>}
                    </TableCell>
                    <TableCell className="text-[14px] text-muted-foreground">
                      {k.kind !== "publishable" ? (
                        <span className="text-subtle-foreground">-</span>
                      ) : k.allowed_origins.length === 0 ? (
                        "Any"
                      ) : (
                        k.allowed_origins.length
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-[13px] text-muted-foreground">
                      {formatTimestamp(k.last_used_at)}
                    </TableCell>
                    <TableCell>
                      {k.revoked_at ? (
                        <Badge variant="muted">revoked</Badge>
                      ) : (
                        <Badge variant="success">active</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {k.kind === "publishable" && !k.revoked_at && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingId(editingId === k.id ? null : k.id)}
                          >
                            Origins
                          </Button>
                        )}
                        {!k.revoked_at && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => revoke.mutate(k.id)}
                            disabled={revoke.isPending}
                          >
                            Revoke
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  {editingId === k.id && (
                    <TableRow>
                      <TableCell colSpan={7} className="bg-sunken">
                        <OriginsEditor apiKey={k} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Test event sender
// ---------------------------------------------------------------------------

function TestEventCard({ secretKey }: { secretKey: string | null }) {
  const { data: me } = useMe();
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Pre-fill email from logged-in user
  const defaultEmail = me?.user?.email ?? "";
  const effectiveEmail = email || defaultEmail;

  if (!secretKey) return null;

  async function sendTestEvent() {
    if (!effectiveEmail || !effectiveEmail.includes("@")) {
      setResult({ ok: false, message: "Enter a valid email address." });
      return;
    }
    setSending(true);
    setResult(null);
    const origin = window.location.origin;
    const userId = "test-event-user";
    const headers = {
      "Authorization": `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    };
    try {
      // Step 1: identify (sets email on contact)
      const idRes = await fetch(`${origin}/v1/identify`, {
        method: "POST",
        headers,
        body: JSON.stringify({ userId, traits: { email: effectiveEmail, name: "Test User" } }),
      });
      if (!idRes.ok) {
        const body = await idRes.text();
        setResult({ ok: false, message: `Identify failed (${idRes.status}): ${body.slice(0, 100)}` });
        setSending(false);
        return;
      }
      // Step 2: track signed_up event
      const trackRes = await fetch(`${origin}/v1/track`, {
        method: "POST",
        headers,
        body: JSON.stringify({ userId, event: "signed_up" }),
      });
      if (!trackRes.ok) {
        const body = await trackRes.text();
        setResult({ ok: false, message: `Track failed (${trackRes.status}): ${body.slice(0, 100)}` });
        setSending(false);
        return;
      }
      setResult({ ok: true, message: `Test event sent. Check People for "${effectiveEmail}" and Sent for the email.` });
    } catch (err) {
      setResult({ ok: false, message: `Network error: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-6">
      <SectionHeading icon={Send} title="Send a test event" />
      <p className="mt-2 text-[14px] text-muted-foreground">
        Send a real <code className="rounded bg-sunken px-1 text-[13px]">signed_up</code> event
        through the ingestion API using your secret key. If you have a welcome
        flow active, this triggers it and sends an email to the address below.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="test-email" className="mb-1.5 block text-[14px] font-medium text-foreground">
            Recipient email
          </label>
          <Input
            id="test-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={defaultEmail || "you@company.com"}
          />
        </div>
        <Button onClick={sendTestEvent} disabled={sending}>
          <Send size={16} strokeWidth={1.5} />
          {sending ? "Sending..." : "Send test event"}
        </Button>
      </div>
      {result && (
        <div
          className={`mt-3 rounded-md border px-3.5 py-2.5 text-[14px] ${
            result.ok
              ? "border-success bg-success-soft text-foreground"
              : "border-danger bg-danger-soft text-foreground"
          }`}
          role="status"
        >
          {result.message}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function IntegratePage() {
  const { data, isLoading } = useIngestKeys();
  const create = useCreateIngestKey();
  const [createdKey, setCreatedKey] = useState<CreatedIngestKey | null>(null);

  const keys = data?.keys ?? [];
  const activePublishable = keys.find((k) => k.kind === "publishable" && !k.revoked_at) ?? null;
  const rawPublishable =
    createdKey && createdKey.kind === "publishable" ? createdKey.key : null;
  // Track the raw secret key for the test-event panel
  const rawSecret =
    createdKey && createdKey.kind === "secret" ? createdKey.key : null;

  function createPublishable() {
    create.mutate({ kind: "publishable" }, { onSuccess: (k) => setCreatedKey(k) });
  }

  // Create a secret key for the test-event panel if none exists
  const activeSecret = keys.find((k) => k.kind === "secret" && !k.revoked_at) ?? null;
  function createSecretForTest() {
    create.mutate({ kind: "secret", label: "Test event key" }, { onSuccess: (k) => setCreatedKey(k) });
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow="Ingestion"
        title="Integrate"
        subtitle="Get events flowing into Claros: grab a key, paste the snippet, watch the first event arrive."
      />

      <div className="space-y-6">
        <FirstEventCard />

        {createdKey && (
          <CreatedKeyBanner created={createdKey} onDismiss={() => setCreatedKey(null)} />
        )}

        {/* Test event panel: appears when a raw secret key is available */}
        {rawSecret ? (
          <TestEventCard secretKey={rawSecret} />
        ) : activeSecret && !rawSecret ? (
          <section className="rounded-lg border border-border bg-card p-6">
            <SectionHeading icon={Send} title="Send a test event" />
            <p className="mt-2 text-[14px] text-muted-foreground">
              Create a secret key to send a test event through the real API.
              The key is shown once at creation and used to send the event.
            </p>
            <Button size="sm" className="mt-3" onClick={createSecretForTest} disabled={create.isPending}>
              <Plus size={16} strokeWidth={1.5} />
              {create.isPending ? "Creating..." : "Create secret key for testing"}
            </Button>
          </section>
        ) : !activeSecret ? (
          <section className="rounded-lg border border-border bg-card p-6">
            <SectionHeading icon={Send} title="Send a test event" />
            <p className="mt-2 text-[14px] text-muted-foreground">
              Create a secret key to send a test event through the real API.
            </p>
            <Button size="sm" className="mt-3" onClick={createSecretForTest} disabled={create.isPending}>
              <Plus size={16} strokeWidth={1.5} />
              {create.isPending ? "Creating..." : "Create secret key"}
            </Button>
          </section>
        ) : null}

        {isLoading ? (
          <Skeleton className="h-64 w-full rounded-lg" />
        ) : (
          <>
            <SnippetCard
              publishableKey={activePublishable}
              rawKey={rawPublishable}
              onCreateKey={createPublishable}
              creating={create.isPending}
            />
            <KeysCard keys={keys} onCreated={setCreatedKey} />
          </>
        )}
      </div>
    </div>
  );
}
