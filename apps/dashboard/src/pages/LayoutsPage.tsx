/**
 * Templates: the email templates of the product (built-in and custom),
 * each with a live preview rendered with the product's brand and a sample
 * message. One is in use; any can be opened in the template studio.
 *
 * Previews are model- or operator-authored HTML: they render in a
 * sandboxed iframe (docs/BRAND.md, Isolated content), scaled to the card.
 */
import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LayoutTemplate, Sparkles, Trash2 } from "lucide-react";
import { PageHeader } from "../components/page-header.js";
import { EmptyState } from "../components/empty-state.js";
import { Button } from "../components/ui/button.js";
import { Badge } from "../components/ui/badge.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { useDeleteLayout, useLayouts, useUseLayout } from "../layouts.js";
import type { LayoutSummary, LayoutWidth } from "../api.js";

type Filter = "all" | LayoutWidth;

/** Width the preview document is laid out at, before scaling to the card. */
const FRAME_WIDTH: Record<LayoutWidth, number> = { narrow: 720, wide: 1100 };
const FRAME_HEIGHT = 900;

/** An email preview scaled to the width of its container. */
export function ScaledPreview({ html, width, title, height = 280 }: { html: string; width: LayoutWidth; title: string; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.4);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const update = () => setScale(el.clientWidth / FRAME_WIDTH[width]);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  return (
    <div ref={box} className="relative w-full overflow-hidden rounded-md border border-border bg-white" style={{ height }} aria-hidden="true">
      <iframe
        sandbox=""
        referrerPolicy="no-referrer"
        title={title}
        srcDoc={html}
        tabIndex={-1}
        className="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
        style={{ width: FRAME_WIDTH[width], height: FRAME_HEIGHT, transform: `scale(${scale})` }}
      />
    </div>
  );
}

function TemplateCard({ t }: { t: LayoutSummary }) {
  const navigate = useNavigate();
  const use = useUseLayout();
  const del = useDeleteLayout();
  const [error, setError] = useState<string | null>(null);
  const open = () => navigate(`/templates/${encodeURIComponent(t.ref)}`);

  return (
    <li className="flex flex-col rounded-lg border border-border bg-card p-4">
      <button
        type="button"
        onClick={open}
        className="block w-full rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label={`Open ${t.name} in the studio`}
      >
        {t.preview_html ? <ScaledPreview html={t.preview_html} width={t.width} title={`${t.name} preview`} /> : <Skeleton className="h-[280px] w-full" />}
      </button>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <p className="mr-auto text-[15px] font-medium text-foreground">{t.name}</p>
        {t.in_use && <Badge variant="success">In use</Badge>}
        <Badge variant="neutral">{t.width === "wide" ? "Wide" : "Narrow"}</Badge>
        <Badge variant={t.kind === "custom" ? "accent" : "muted"}>{t.kind === "custom" ? "Custom" : "Built-in"}</Badge>
      </div>
      {t.description && <p className="mt-2 text-[13px] leading-[20px] text-muted-foreground">{t.description}</p>}
      {error && <p className="mt-2 text-[13px] text-danger" role="alert">{error}</p>}
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        <Button size="sm" variant="outline" onClick={open}>
          <Sparkles strokeWidth={1.5} />
          Edit in studio
        </Button>
        {!t.in_use && (
          <Button
            size="sm"
            variant="ghost"
            disabled={use.isPending}
            onClick={() => {
              setError(null);
              use.mutate(t.ref, { onError: (e) => setError(e.message) });
            }}
          >
            {use.isPending ? "Switching..." : "Use for this product"}
          </Button>
        )}
        {t.kind === "custom" && !t.in_use && (
          <Button
            size="icon"
            variant="ghost"
            className="ml-auto"
            aria-label={`Delete ${t.name}`}
            disabled={del.isPending}
            onClick={() => {
              if (!window.confirm(`Delete the template "${t.name}"? This cannot be undone.`)) return;
              setError(null);
              del.mutate(t.id!, { onError: (e) => setError(e.message) });
            }}
          >
            <Trash2 strokeWidth={1.5} />
          </Button>
        )}
      </div>
    </li>
  );
}

export function LayoutsPage() {
  const q = useLayouts();
  const [filter, setFilter] = useState<Filter>("all");
  const navigate = useNavigate();
  const templates = (q.data?.templates ?? []).filter((t) => filter === "all" || t.width === filter);
  const inUse = q.data?.templates.find((t) => t.in_use);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Templates"
        subtitle={
          inUse
            ? `Every email of this product is sent in the ${inUse.name} template. Open any template in the studio and describe the change you want.`
            : "The design every email of this product is sent in. Open any template in the studio and describe the change you want."
        }
        actions={
          <Button onClick={() => navigate(`/templates/${encodeURIComponent(inUse?.ref ?? "classic")}`)}>
            <Sparkles strokeWidth={1.5} />
            Open in studio
          </Button>
        }
      />

      <div className="mb-6 inline-flex rounded-md border border-border bg-sunken p-0.5" role="tablist" aria-label="Filter by width">
        {(["all", "narrow", "wide"] as const).map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={`h-8 rounded-sm px-3 text-[13px] font-medium transition-colors duration-(--dur-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              filter === f ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {f === "all" ? "All" : f === "narrow" ? "Narrow" : "Wide"}
          </button>
        ))}
      </div>

      {q.isLoading && (
        <ul className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="rounded-lg border border-border p-4">
              <Skeleton className="h-[280px] w-full" />
              <Skeleton className="mt-4 h-5 w-1/2" />
              <Skeleton className="mt-2 h-4 w-full" />
            </li>
          ))}
        </ul>
      )}

      {q.isError && (
        <div className="flex items-center justify-between gap-4 rounded-md border border-danger bg-danger-soft px-4 py-3 text-[14px] text-foreground" role="alert">
          <span>Could not load templates: {q.error.message}</span>
          <Button size="sm" variant="outline" onClick={() => void q.refetch()}>Try again</Button>
        </div>
      )}

      {q.data && templates.length === 0 && (
        <EmptyState icon={LayoutTemplate} title="No templates of this width" description="Pick another filter, or open a template in the studio and switch its width." compact />
      )}

      {q.data && templates.length > 0 && (
        <ul className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {templates.map((t) => <TemplateCard key={t.ref} t={t} />)}
        </ul>
      )}

      <p className="mt-8 text-[13px] text-muted-foreground">
        Templates use your <Link to="/settings/branding" className="text-accent-text underline">branding</Link> (logo, accent color, footer text). Every template keeps the unsubscribe link and postal address.
      </p>
    </div>
  );
}
