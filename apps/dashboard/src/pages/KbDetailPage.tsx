/**
 * Knowledge base entry detail page.
 *
 * Full content, embedding state (with the provider's error verbatim when
 * failed), edit via PATCH, and hard delete behind a two-step confirmation.
 * HTML content renders in the same sandboxed frame discipline as the
 * approval draft preview; markdown and text render as preformatted text
 * (no markdown renderer is bundled).
 */
import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useKbEntry, useUpdateKbEntry, useDeleteKbEntry } from "../kb.js";
import type { KbEntry, FlowApiError } from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { embeddingVariant, embeddingLabel } from "../kb-embedding.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Select } from "../components/ui/select.js";
import { Textarea } from "../components/ui/textarea.js";
import { Skeleton } from "../components/ui/skeleton.js";

const CONTENT_TYPES = ["markdown", "html", "text"] as const;

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function errorMessage(err: unknown): string {
  if (err !== null && typeof err === "object" && "kind" in err) {
    const apiErr = err as FlowApiError;
    if (apiErr.kind === "validation") {
      return apiErr.issues.map((i) => i.message).join("; ");
    }
    return apiErr.message;
  }
  return err instanceof Error ? err.message : "An unexpected error occurred.";
}

function EntryContent({ entry }: { entry: KbEntry }) {
  if (entry.content_type === "html") {
    return (
      <iframe
        sandbox=""
        referrerPolicy="no-referrer"
        title="Entry content"
        srcDoc={entry.content}
        className="h-[420px] w-full rounded-md border border-border bg-white"
      />
    );
  }
  return (
    <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-4 font-mono text-[14px] leading-relaxed text-foreground">
      {entry.content}
    </pre>
  );
}

export default function KbDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const entryQuery = useKbEntry(id ?? "");
  const update = useUpdateKbEntry(id ?? "");
  const del = useDeleteKbEntry(id ?? "");

  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  const [title, setTitle] = useState("");
  const [contentType, setContentType] = useState<KbEntry["content_type"]>("markdown");
  const [sourceUrl, setSourceUrl] = useState("");
  const [tags, setTags] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("");
  const [pinned, setPinned] = useState(false);

  const entry = entryQuery.data;

  useEffect(() => {
    if (entry && !editing) {
      setTitle(entry.title);
      setContentType(entry.content_type);
      setSourceUrl(entry.source_url ?? "");
      setTags(entry.tags.join(", "));
      setIsActive(entry.is_active);
      setContent(entry.content);
      setCategory(entry.category ?? "");
      setPinned(entry.pinned === true);
    }
  }, [entry, editing]);

  if (entryQuery.isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (entryQuery.isError || !entry) {
    return (
      <div className="mx-auto max-w-4xl">
        <div
          className="rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-[17px] text-foreground">
            Failed to load entry:{" "}
            {entryQuery.error instanceof Error
              ? entryQuery.error.message
              : "Unknown error"}
          </p>
        </div>
      </div>
    );
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSavedNotice(false);
    try {
      await update.mutateAsync({
        title: title.trim(),
        content,
        content_type: contentType,
        source_url: sourceUrl.trim() === "" ? undefined : sourceUrl.trim(),
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0),
        is_active: isActive,
        category: category.trim() === "" ? null : category.trim(),
        pinned,
      });
      setEditing(false);
      setSavedNotice(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleDelete() {
    setError(null);
    try {
      await del.mutateAsync();
      navigate("/kb");
    } catch (err) {
      setError(errorMessage(err));
      setConfirmingDelete(false);
    }
  }

  const busy = update.isPending || del.isPending;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-8">
        <Link
          to="/kb"
          className="text-[16px] text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground"
        >
          &larr; Knowledge Base
        </Link>
        <div className="mt-2 flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="truncate font-display text-[34px] font-bold leading-[40px] tracking-[-0.025em] text-foreground">
              {entry.title}
            </h1>
            {!entry.is_active && <Badge variant="muted">inactive</Badge>}
            {entry.pinned && <Badge variant="neutral">pinned</Badge>}
            <Badge
              variant={embeddingVariant(entry.embedding_status)}
              pulse={entry.embedding_status === "pending"}
            >
              {embeddingLabel(entry.embedding_status)}
            </Badge>
          </div>
          {!editing && (
            <div className="flex shrink-0 items-center gap-2">
              {confirmingDelete ? (
                <>
                  <span className="text-[16px] text-muted-foreground">
                    Delete permanently? This is a hard delete.
                  </span>
                  <Button variant="destructive" size="sm" disabled={busy} onClick={handleDelete}>
                    Delete
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmingDelete(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmingDelete(true)}>
                    Delete
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => { setEditing(true); setSavedNotice(false); }}>
                    Edit
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {error && (
        <div
          className="mb-6 rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-[17px] text-foreground">{error}</p>
        </div>
      )}

      {entry.embedding_status === "failed" && entry.embedding_error && (
        <div
          className="mb-6 rounded-md border border-danger bg-danger-soft px-3.5 py-2.5"
          role="alert"
        >
          <p className="whitespace-pre-wrap break-words font-mono text-[14px] text-foreground">
            {entry.embedding_error}
          </p>
        </div>
      )}

      {savedNotice && !editing && (
        <p
          className="mb-6 rounded-md border border-border bg-secondary px-4 py-3 text-[16px] text-foreground"
          role="status"
        >
          Saved. The entry will be re-embedded automatically.
        </p>
      )}

      {editing ? (
        <form onSubmit={handleSave} noValidate className="space-y-5">
          <div>
            <label htmlFor="kb-title" className="mb-1.5 block text-[16px] font-medium text-foreground">
              Title
            </label>
            <Input
              id="kb-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="kb-type" className="mb-1.5 block text-[16px] font-medium text-foreground">
                Content type
              </label>
              <Select
                id="kb-type"
                value={contentType}
                onChange={(e) => setContentType(e.target.value as KbEntry["content_type"])}
                disabled={busy}
              >
                {CONTENT_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </Select>
            </div>
            <div>
              <label htmlFor="kb-source-url" className="mb-1.5 block text-[16px] font-medium text-foreground">
                Source URL
              </label>
              <Input
                id="kb-source-url"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://..."
                disabled={busy}
              />
            </div>
          </div>
          <div>
            <label htmlFor="kb-tags" className="mb-1.5 block text-[16px] font-medium text-foreground">
              Tags <span className="font-normal text-muted-foreground">(comma separated)</span>
            </label>
            <Input
              id="kb-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="pricing, onboarding"
              disabled={busy}
            />
          </div>
          <div>
            <label htmlFor="kb-category" className="mb-1.5 block text-[16px] font-medium text-foreground">
              Category <span className="font-normal text-muted-foreground">(used by a step's kb_select)</span>
            </label>
            <Input
              id="kb-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="tip_trick"
              maxLength={120}
              disabled={busy}
            />
          </div>
          <div>
            <label htmlFor="kb-content" className="mb-1.5 block text-[16px] font-medium text-foreground">
              Content
            </label>
            <Textarea
              id="kb-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="min-h-56 font-mono text-[14px]"
              disabled={busy}
              required
            />
          </div>
          <label className="flex w-fit cursor-pointer items-center gap-2 text-[16px] text-foreground">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
              disabled={busy}
            />
            Active (inactive entries are not used by the AI)
          </label>
          <label className="flex w-fit cursor-pointer items-center gap-2 text-[16px] text-foreground">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
              disabled={busy}
            />
            Pinned (always given to the drafting model)
          </label>
          <div className="flex items-center gap-3 border-t border-border pt-5">
            <Button type="submit" disabled={busy || title.trim().length === 0 || content.trim().length === 0}>
              {update.isPending ? "Saving..." : "Save changes"}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <dl className="mb-6 flex flex-wrap gap-x-8 gap-y-2 text-[16px] text-muted-foreground">
            <div>
              <dt className="inline">Type: </dt>
              <dd className="inline font-mono text-[14px]">{entry.content_type}</dd>
            </div>
            <div>
              <dt className="inline">Source: </dt>
              <dd className="inline font-mono text-[14px]">{entry.source}</dd>
            </div>
            {entry.source_url && (
              <div>
                <dt className="inline">URL: </dt>
                <dd className="inline">
                  <a
                    href={entry.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent-text underline underline-offset-4"
                  >
                    {entry.source_url}
                  </a>
                </dd>
              </div>
            )}
            <div>
              <dt className="inline">Category: </dt>
              <dd className="inline font-mono text-[14px]">{entry.category ?? "none"}</dd>
            </div>
            {entry.external_key && (
              <div>
                <dt className="inline">External key: </dt>
                <dd className="inline font-mono text-[14px]">{entry.external_key}</dd>
              </div>
            )}
            <div>
              <dt className="inline">Updated: </dt>
              <dd className="inline font-mono text-[14px]">{formatDateTime(entry.updated_at)}</dd>
            </div>
          </dl>
          {entry.tags.length > 0 && (
            <div className="mb-6 flex flex-wrap gap-2">
              {entry.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-sunken px-2 py-0.5 font-mono text-[14px] text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
          <EntryContent entry={entry} />
          {entry.data !== undefined && entry.data !== null && (
            <div className="mt-8">
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                Source data (read-only)
              </p>
              <pre className="max-h-96 overflow-auto rounded-md border border-border bg-sunken p-4 font-mono text-[14px] leading-relaxed text-foreground">
                {JSON.stringify(entry.data, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
