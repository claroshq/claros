/**
 * Knowledge base list page.
 *
 * The corpus the AI writes from. The job here is "what does the AI know
 * about X, and is it right?", so the page is built around finding:
 *
 *   - A category rail on the left (sticky on wide screens, a chip row on
 *     narrow ones) with counts. Categories are the kb_select unit, so the
 *     section header also shows the raw key a flow step refers to.
 *   - A search field over title, preview text, tags and category. It runs
 *     on the loaded entries; the list endpoint is paged.
 *   - Rows read as prose: the 300-character preview is stripped of
 *     markdown and HTML syntax. Pinned shows as a pin icon, the date is
 *     relative. Only exceptions are loud: embedding badges appear for
 *     pending, failed and (with a provider) skipped entries, never for
 *     "embedded".
 *
 * Category and search live in the URL (?category=, ?q=) so coming back
 * from an entry keeps the view.
 *
 * Re-embed is asynchronous and returns counts, not a job: { enqueued,
 * remaining, total_qualifying }. remaining > 0 means another batch is
 * waiting; the button offers it. The button sits in the failure note, and
 * only shows when an entry failed.
 */
import React, { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Plus, BookOpen, Upload, Pin, Search, SearchX } from "lucide-react";
import { useKbEntries, useReembedKb } from "../kb.js";
import { useEmbeddings } from "../settings.js";
import type { KbEntryPreview, FlowApiError } from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { embeddingVariant, embeddingLabel } from "../kb-embedding.js";
import { groupEntries, UNCATEGORIZED, type EntryGroup } from "../kb-groups.js";
import { categoryLabel, matchesQuery, plainPreview } from "../kb-preview.js";
import { ago } from "../lib/time.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { PageHeader } from "../components/page-header.js";
import { EmptyState } from "../components/empty-state.js";
import { cn } from "../lib/utils.js";

const MAX_TAGS = 4;
const ALL = "";

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

function groupLabel(name: string): string {
  return name === UNCATEGORIZED ? UNCATEGORIZED : categoryLabel(name);
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

function KbRow({
  entry,
  hideSkipped,
  onOpen,
}: {
  entry: KbEntryPreview;
  /** With no embedding provider every entry is skipped; the page note says so once. */
  hideSkipped: boolean;
  onOpen: () => void;
}) {
  const status = entry.embedding_status;
  const showEmbedding = status !== null && !(status === "skipped" && hideSkipped);
  const shownTags = entry.tags.slice(0, MAX_TAGS);
  const hiddenTags = entry.tags.length - shownTags.length;
  const showType = entry.content_type !== "markdown";
  const preview = plainPreview(entry.content_preview, entry.content_type);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="block w-full px-5 py-4 text-left transition-colors duration-(--dur-fast) hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <div className="flex items-center gap-2">
        {entry.pinned && (
          <span
            className="shrink-0 text-accent-text"
            title="Pinned: always reaches the drafting model"
          >
            <Pin size={14} strokeWidth={2} aria-hidden="true" />
            <span className="sr-only">Pinned.</span>
          </span>
        )}
        <span
          className={cn(
            "truncate text-body font-medium",
            entry.is_active ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {entry.title}
        </span>
        {!entry.is_active && <Badge variant="muted">inactive</Badge>}
        {showEmbedding && (
          <Badge variant={embeddingVariant(status)} pulse={status === "pending"}>
            {embeddingLabel(status)}
          </Badge>
        )}
        <span
          className="ml-auto shrink-0 pl-4 text-caption tabular-nums text-subtle-foreground"
          title={new Date(entry.updated_at).toLocaleString()}
        >
          {ago(entry.updated_at)}
        </span>
      </div>
      {preview && (
        <p className="mt-1 line-clamp-2 text-body leading-relaxed text-muted-foreground">
          {preview}
        </p>
      )}
      {(shownTags.length > 0 || showType) && (
        <p
          className="mt-2 truncate font-mono text-caption text-subtle-foreground"
          title={entry.tags.length > 0 ? entry.tags.join(", ") : undefined}
        >
          {showType && <span className="text-muted-foreground">{entry.content_type}</span>}
          {showType && shownTags.length > 0 && "  ·  "}
          {shownTags.join(" · ")}
          {hiddenTags > 0 && ` +${hiddenTags}`}
        </p>
      )}
    </button>
  );
}

function RailItem({
  label,
  count,
  selected,
  onSelect,
}: {
  label: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex shrink-0 items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-body transition-colors duration-(--dur-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:w-full",
        selected
          ? "bg-selected font-medium text-foreground"
          : "text-muted-foreground hover:bg-hover hover:text-foreground",
      )}
    >
      <span className="truncate">{label}</span>
      <span className="text-small font-normal tabular-nums text-subtle-foreground">{count}</span>
    </button>
  );
}

function CategoryRail({
  groups,
  total,
  selected,
  onSelect,
  includeInactive,
  onIncludeInactive,
}: {
  groups: EntryGroup[];
  total: number;
  selected: string;
  onSelect: (name: string) => void;
  includeInactive: boolean;
  onIncludeInactive: (v: boolean) => void;
}) {
  const showCategories = !(groups.length === 1 && groups[0]!.name === UNCATEGORIZED);
  return (
    <aside className="mb-6 lg:sticky lg:top-6 lg:mb-0 lg:self-start">
      {showCategories && (
        <nav aria-label="Categories">
          <p className="mb-2 hidden px-2.5 text-micro font-semibold uppercase tracking-[0.07em] text-subtle-foreground lg:block">
            Categories
          </p>
          <div className="flex flex-wrap gap-1 lg:block lg:space-y-0.5">
            <RailItem
              label="All entries"
              count={total}
              selected={selected === ALL}
              onSelect={() => onSelect(ALL)}
            />
            {groups.map((g) => (
              <RailItem
                key={g.name}
                label={groupLabel(g.name)}
                count={g.entries.length}
                selected={selected === g.name}
                onSelect={() => onSelect(g.name)}
              />
            ))}
          </div>
        </nav>
      )}
      <div className={cn(showCategories && "mt-4 lg:mt-6 lg:border-t lg:border-border lg:pt-4")}>
        <label className="flex w-fit cursor-pointer items-center gap-2 px-2.5 text-small text-muted-foreground">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => onIncludeInactive(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--accent)]"
          />
          Show inactive entries
        </label>
      </div>
    </aside>
  );
}

function KbEmptyState({
  includeInactive,
  onShowInactive,
}: {
  includeInactive: boolean;
  onShowInactive: () => void;
}) {
  return (
    <EmptyState
      icon={BookOpen}
      title={includeInactive ? "No entries at all" : "No active entries"}
      description="The knowledge base is the corpus the AI writes from: your product facts, your playbooks, your voice. Import what you already have (Markdown, CSV, JSONL) or write the first entry, so drafts have something true to say."
      action={
        <div className="flex flex-col items-center gap-4">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Link to="/kb/import">
              <Button size="sm">
                <Upload size={16} strokeWidth={1.5} />
                Import entries
              </Button>
            </Link>
            <Link to="/kb/new">
              <Button size="sm" variant="outline">
                <Plus size={16} strokeWidth={1.5} />
                New entry
              </Button>
            </Link>
          </div>
          {!includeInactive && (
            <button
              type="button"
              onClick={onShowInactive}
              className="text-small text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Show inactive entries
            </button>
          )}
        </div>
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

  const [params, setParams] = useSearchParams();
  const requestedCategory = params.get("category") ?? ALL;
  const query = params.get("q") ?? "";

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  }

  const entries = useMemo(
    () => list.data?.pages.flatMap((p) => p.entries) ?? [],
    [list.data],
  );

  const failedCount = entries.filter((e) => e.embedding_status === "failed").length;
  const groups = useMemo(() => groupEntries(entries), [entries]);
  const showGroupHeaders = !(groups.length === 1 && groups[0]!.name === UNCATEGORIZED);
  // A category that no longer exists (deleted, or hidden by the inactive
  // toggle) falls back to all entries instead of an empty page.
  const category = groups.some((g) => g.name === requestedCategory) ? requestedCategory : ALL;

  const visibleGroups = useMemo(
    () =>
      groups
        .filter((g) => category === ALL || g.name === category)
        .map((g) => ({ ...g, entries: g.entries.filter((e) => matchesQuery(e, query)) }))
        .filter((g) => g.entries.length > 0),
    [groups, category, query],
  );
  const matchCount = visibleGroups.reduce((n, g) => n + g.entries.length, 0);
  const filtering = query.trim() !== "" || category !== ALL;

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

  const loaded = !list.isLoading && !list.isError;
  const showLayout = loaded && (entries.length > 0 || includeInactive);

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
            <Link to="/kb/import">
              <Button variant="outline" size="sm">
                <Upload size={16} strokeWidth={1.5} />
                Import
              </Button>
            </Link>
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
          className="mb-6 rounded-md border border-border bg-secondary px-4 py-3 text-body text-foreground"
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
          <p className="text-lead text-foreground">{reembedError}</p>
        </div>
      )}

      {list.isLoading && <ListSkeleton />}

      {list.isError && (
        <div
          className="flex items-center justify-between rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-lead text-foreground">
            Failed to load entries:{" "}
            {list.error instanceof Error ? list.error.message : "Unknown error"}
          </p>
          <Button variant="outline" size="sm" onClick={() => list.refetch()}>
            Try again
          </Button>
        </div>
      )}

      {loaded && !showLayout && (
        <KbEmptyState includeInactive={includeInactive} onShowInactive={() => setIncludeInactive(true)} />
      )}

      {showLayout && (
        <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
          <CategoryRail
            groups={groups}
            total={entries.length}
            selected={category}
            onSelect={(name) => setParam("category", name)}
            includeInactive={includeInactive}
            onIncludeInactive={setIncludeInactive}
          />

          <div className="min-w-0">
            {entries.length === 0 ? (
              <KbEmptyState includeInactive onShowInactive={() => setIncludeInactive(true)} />
            ) : (
              <>
                <div className="relative mb-6">
                  <Search
                    size={16}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    type="search"
                    aria-label="Search entries"
                    placeholder="Search titles, text and tags"
                    value={query}
                    onChange={(e) => setParam("q", e.target.value)}
                    className="pl-9"
                  />
                </div>

                {noEmbeddingProvider && (
                  <p className="mb-4 text-body text-muted-foreground">
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
                  <div
                    className="mb-6 flex flex-col gap-3 rounded-md border border-border bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                    role="status"
                  >
                    <p className="text-body text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {failedCount} {failedCount === 1 ? "entry" : "entries"} failed to embed.
                      </span>{" "}
                      Semantic search skips them; pinned entries and kb_select
                      still use them. Open an entry to see the provider's error
                      and fix it in{" "}
                      <Link to="/settings/llm" className="font-medium text-foreground underline underline-offset-2">
                        Settings, AI providers
                      </Link>
                      .
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      disabled={reembed.isPending}
                      onClick={handleReembed}
                      title="Enqueue embedding jobs for entries that failed or were orphaned"
                    >
                      {reembed.isPending ? "Retrying..." : "Retry failed"}
                    </Button>
                  </div>
                )}

                {visibleGroups.length === 0 ? (
                  <EmptyState
                    compact
                    icon={SearchX}
                    title="No entries match"
                    description={
                      list.hasNextPage
                        ? "Search covers the entries loaded so far. Load more below, or try other words."
                        : "Try other words, or search all categories."
                    }
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setParams(new URLSearchParams(), { replace: true })}
                      >
                        Show all entries
                      </Button>
                    }
                  />
                ) : (
                  <>
                    {filtering && (
                      <p className="-mt-2 mb-4 text-small text-muted-foreground" role="status">
                        {matchCount} {matchCount === 1 ? "entry" : "entries"}
                      </p>
                    )}
                    <div className="space-y-10">
                      {visibleGroups.map((group) => (
                        <section key={group.name} aria-label={showGroupHeaders ? groupLabel(group.name) : undefined}>
                          {showGroupHeaders && (
                            <div className="mb-3 flex items-baseline gap-2">
                              <h2 className="text-title font-semibold leading-6 tracking-[-0.01em] text-foreground">
                                {groupLabel(group.name)}
                              </h2>
                              <span className="text-body font-medium tabular-nums text-subtle-foreground">
                                {group.entries.length}
                              </span>
                              {group.name !== UNCATEGORIZED && groupLabel(group.name).toLowerCase() !== group.name.toLowerCase() && (
                                <code
                                  className="ml-auto font-mono text-caption text-subtle-foreground"
                                  title="Category key, as a step's kb_select names it"
                                >
                                  {group.name}
                                </code>
                              )}
                            </div>
                          )}
                          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card shadow-card">
                            {group.entries.map((entry) => (
                              <KbRow
                                key={entry.id}
                                entry={entry}
                                hideSkipped={noEmbeddingProvider}
                                onOpen={() => navigate(`/kb/${entry.id}`)}
                              />
                            ))}
                          </div>
                        </section>
                      ))}
                    </div>
                  </>
                )}

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
        </div>
      )}
    </div>
  );
}
