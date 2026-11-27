/**
 * Knowledge base new entry page.
 *
 * Deliberately two fields: a title and the material itself. The AI writes
 * from title + content; nothing else on the entry is read downstream
 * (content_type, source_url, and tags are provenance for a future
 * auto-crawl, not things a human should fill in).
 *
 * Creates an entry via POST /v1/kb, then lands on its detail page.
 * Creating enqueues an embedding job server-side; the entry's embedding
 * state is visible immediately after.
 */
import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useCreateKbEntry } from "../kb.js";
import type { FlowApiError } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Textarea } from "../components/ui/textarea.js";

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

export default function KbNewPage() {
  const navigate = useNavigate();
  const create = useCreateKbEntry();

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("");
  const [pinned, setPinned] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await create.mutateAsync({
        title: title.trim(),
        content,
        source: "manual",
        ...(category.trim() !== "" ? { category: category.trim() } : {}),
        ...(pinned ? { pinned: true } : {}),
      });
      navigate(`/kb/${created.id}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const busy = create.isPending;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-8">
        <Link
          to="/kb"
          className="text-[16px] text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground"
        >
          &larr; Knowledge Base
        </Link>
        <h1 className="mt-2 font-display text-[34px] font-bold leading-[40px] tracking-[-0.025em] text-foreground">
          New entry
        </h1>
        <p className="mt-2 max-w-xl text-[16px] leading-relaxed text-muted-foreground">
          Something true about your product the AI should write from: a
          playbook, a pricing fact, a voice guide. Write it like you would
          explain it to a new teammate - the AI drafts emails from this
          material and nothing else.
        </p>
      </div>

      {error && (
        <div
          className="mb-6 rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-[17px] text-foreground">{error}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        <div>
          <label htmlFor="kb-title" className="mb-1.5 block text-[16px] font-medium text-foreground">
            Title <span className="text-danger" aria-hidden="true">*</span>
          </label>
          <Input
            id="kb-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Win-back playbook"
            disabled={busy}
            required
          />
        </div>
        <div>
          <label htmlFor="kb-content" className="mb-1.5 block text-[16px] font-medium text-foreground">
            Content <span className="text-danger" aria-hidden="true">*</span>
          </label>
          <Textarea
            id="kb-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="min-h-72 font-mono text-[14px]"
            placeholder={"Write or paste the material here.\n\nMarkdown works: headings, lists, bold. Keep it factual - the closer this reads to truth, the better the drafts."}
            disabled={busy}
            required
          />
        </div>
        <div>
          <label htmlFor="kb-category" className="mb-1.5 block text-[16px] font-medium text-foreground">
            Category <span className="font-normal text-muted-foreground">(optional, used by a step's kb_select)</span>
          </label>
          <Input
            id="kb-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="e.g. tip_trick"
            maxLength={120}
            disabled={busy}
          />
        </div>
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
            {busy ? "Creating..." : "Create entry"}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => navigate("/kb")}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
