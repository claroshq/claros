/**
 * Knowledge base list page.
 *
 * The corpus the AI writes from. Each row shows the entry's preview inline
 * (the list endpoint truncates content to 300 characters), so nobody has to
 * open an entry to know what it says. Embedding state is a first-class
 * signal: pending, failed, skipped (no embedding provider: word matching),
 * or embedded.
 *
 * Re-embed is asynchronous and returns counts, not a job: { enqueued,
 * remaining, total_qualifying }. remaining > 0 means another batch is
 * waiting; the button offers it. That is the only progress signal the API
 * reports, and it is what the UI shows. No invented progress bar.
 */
import React, { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, BookOpen } from "lucide-react";
import { useKbEntries, useReembedKb } from "../kb.js";
import { useEmbeddings } from "../settings.js";
import type { KbEntryPreview, FlowApiError } from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { embeddingVariant, embeddingLabel } from "../kb-embedding.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { PageHeader } from "../components/page-header.js";
import { EmptyState } from "../components/empty-state.js";
import { cn } from "../lib/utils.js";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function actionErrorMessage(err: unknown): string {
  if (err !== null && typeof err === "object" && "kind" in err) {
    const apiErr = err as FlowApiError;
    if (apiErr.kind === "validation") {
      return apiErr.issues.map((i) => i.message).join("; ");
    }
    return apiErr.message;
  }
  return err instanceof Error ? err.message : "An unexpected error occurred.";
}

function ListSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-20 w-full" />
      ))}
    </div>
  );
}

function KbEmptyState({ includeInactive }: { includeInactive: boolean }) {
  return (
    <EmptyState
      icon={BookOpen}
      title={includeInactive ? "No entries at all" : "No active entries"}
      description="The knowledge base is the corpus the AI writes from: your product facts, your playbooks, your voice. Add the first entry so drafts have something true to say."
      action={
        <Link to="/kb/new">
          <Button size="sm">
            <Plus size={16} strokeWidth={1.5} />
            New entry
          </Button>
        </Link>
      }
    />
  );
}

export default function KbPage() {
  const [includeInactive, setIncludeInactive] = useState(false);
  const list = useKbEntries(includeInactive);
  const reembed = useReembedKb();
  const embeddings = useEmbeddings();
  const noEmbeddingProvider = embeddings.data !== undefined && embeddings.data.embeddings === null;
  const navigate = useNavigate();
  const [reembedNote, setReembedNote] = useState<string | null>(null);
  const [reembedError, setReembedError] = useState<string | null>(null);

  const entries = useMemo(
    () => list.data?.pages.flatMap((p) => p.entries) ?? [],
    [list.data],
  );

  const failedCount = entries.filter((e) => e.embedding_status === "failed").length;

  function handleReembed() {
    setReembedNote(null);
    setReembedError(null);
    reembed.mutate(undefined, {
      onSuccess: (data) => {
        if (data.enqueued === 0) {
          setReembedNote(
            "Nothing to retry. No failed or stuck entries right now.",
          );
        } else if (data.remaining > 0) {
          setReembedNote(
            `Re-embedding started for ${data.enqueued} ${data.enqueued === 1 ? "entry" : "entries"}. ${data.remaining} more ${data.remaining === 1 ? "is" : "are"} waiting - run it again for the next batch. Badges flip to "embedded" as jobs finish.`,
          );
        } else {
          setReembedNote(
            `Re-embedding started for ${data.enqueued} ${data.enqueued === 1 ? "entry" : "entries"}. Badges flip to "embedded" as jobs finish.`,
          );
        }
      },
      onError: (err) => setReembedError(actionErrorMessage(err)),
    });
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow="Corpus"
        title="Knowledge Base"
        subtitle={
          list.isLoading
            ? "The corpus the AI writes from."
            : `${entries.length} ${entries.length === 1 ? "entry" : "entries"}${list.hasNextPage ? " loaded, more available" : ""}`
        }
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={reembed.isPending}
              onClick={handleReembed}
              title="Enqueue embedding jobs for entries that failed or were orphaned"
            >
              {reembed.isPending ? "Retrying..." : "Retry failed embeddings"}
            </Button>
            <Link to="/kb/new">
              <Button size="sm">
                <Plus size={16} strokeWidth={1.5} />
                New entry
              </Button>
            </Link>
          </>
        }
      />

      {reembedNote && (
        <p
          className="mb-6 rounded-md border border-border bg-secondary px-4 py-3 text-[14px] text-foreground"
          role="status"
        >
          {reembedNote}
        </p>
      )}
      {reembedError && (
        <div
          className="mb-6 rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-[15px] text-foreground">{reembedError}</p>
        </div>
      )}

      <label className="mb-4 flex w-fit cursor-pointer items-center gap-2 text-[14px] text-muted-foreground">
        <input
          type="checkbox"
          checked={includeInactive}
          onChange={(e) => setIncludeInactive(e.target.checked)}
          className="h-3.5 w-3.5 accent-[var(--accent)]"
        />
        Show inactive entries
      </label>

      {list.isLoading && <ListSkeleton />}

      {list.isError && (
        <div
          className="flex items-center justify-between rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-[15px] text-foreground">
            Failed to load entries:{" "}
            {list.error instanceof Error ? list.error.message : "Unknown error"}
          </p>
          <Button variant="outline" size="sm" onClick={() => list.refetch()}>
            Try again
          </Button>
        </div>
      )}

      {!list.isLoading && !list.isError && entries.length === 0 && (
        <KbEmptyState includeInactive={includeInactive} />
      )}

      {entries.length > 0 && (
        <>
          {noEmbeddingProvider && (
            <p className="mb-4 text-[14px] text-muted-foreground">
              No embedding provider, so drafts find entries by shared words
              instead of meaning. Pinned entries and kb_select are not
              affected. To add one, open{" "}
              <Link to="/settings/llm" className="font-medium text-foreground underline underline-offset-2">
                Settings, AI providers
              </Link>
              .
            </p>
          )}
          {failedCount > 0 && (
            <p className="mb-4 text-[14px] text-muted-foreground">
              {failedCount} {failedCount === 1 ? "entry" : "entries"} failed
              to embed. Semantic search skips them; pinned entries and
              kb_select still use them. Open an entry to see the provider's
              error, fix it in{" "}
              <Link to="/settings/llm" className="font-medium text-foreground underline underline-offset-2">
                Settings, AI providers
              </Link>
              , then use{" "}
              <span className="font-medium text-foreground">
                Retry failed embeddings
              </span>{" "}
              above.
            </p>
          )}
          <div className="divide-y divide-border border-t border-b border-border">
            {entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => navigate(`/kb/${entry.id}`)}
                className="block w-full px-1 py-4 text-left transition-colors duration-(--dur-fast) hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "text-[14px] font-medium",
                      entry.is_active ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {entry.title}
                  </span>
                  {!entry.is_active && <Badge variant="muted">inactive</Badge>}
                  {entry.pinned && <Badge variant="neutral">pinned</Badge>}
                  <Badge
                    variant={embeddingVariant(entry.embedding_status)}
                    pulse={entry.embedding_status === "pending"}
                  >
                    {embeddingLabel(entry.embedding_status)}
                  </Badge>
                  <span className="ml-auto font-mono text-[13px] text-muted-foreground">
                    {formatDate(entry.updated_at)}
                  </span>
                </div>
                <p className="mt-1.5 line-clamp-2 text-[14px] leading-relaxed text-muted-foreground">
                  {entry.content_preview}
                </p>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="font-mono text-[12px] text-subtle-foreground">
                    {entry.content_type}
                  </span>
                  {entry.category && (
                    <span className="font-mono text-[12px] text-muted-foreground">{entry.category}</span>
                  )}
                  {entry.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-sunken px-2 py-0.5 font-mono text-[12px] text-muted-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </button>
            ))}
          </div>
          {list.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                disabled={list.isFetchingNextPage}
                onClick={() => list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? "Loading..." : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
