/**
 * Email templates page - view and edit email template content.
 *
 * Lists all installed email templates and allows editing subject, body HTML,
 * and body text. Shows available variables for interpolation.
 */
import React, { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Mail } from "lucide-react";
import { PageHeader } from "../components/page-header.js";
import { EmptyState } from "../components/empty-state.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Textarea } from "../components/ui/textarea.js";
import { Badge } from "../components/ui/badge.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { withProduct } from "../product.js";

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

interface EmailTemplate {
  id: string;
  name: string;
  slug: string;
  subject: string;
  body_html: string;
  body_text: string | null;
  variables: string[] | null;
  category: string | null;
  is_active: boolean;
  created_at: string;
}

interface EmailTemplatesResponse {
  templates: EmailTemplate[];
  supported_variables: readonly string[];
}

async function fetchEmailTemplates(): Promise<EmailTemplatesResponse> {
  const res = await fetch("/v1/email-templates", withProduct());
  if (!res.ok) throw new Error(`Failed to load templates (${res.status})`);
  return res.json();
}

async function patchEmailTemplate(
  id: string,
  data: { subject?: string; body_html?: string; body_text?: string | null },
): Promise<{ template: EmailTemplate }> {
  const res = await fetch(`/v1/email-templates/${id}`, withProduct({
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }));
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg = body && typeof body === "object" && "error" in body
      ? String(body.error)
      : `Save failed (${res.status})`;
    throw new Error(msg);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const TEMPLATES_KEY = ["email-templates"] as const;

function VariableReference({ variables }: { variables: readonly string[] }) {
  return (
    <div className="rounded-md border border-border bg-sunken p-3">
      <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        Available variables
      </p>
      <div className="flex flex-wrap gap-1.5">
        {variables.map((v) => (
          <code
            key={v}
            className="rounded border border-border bg-card px-2 py-0.5 font-mono text-[12px] text-foreground"
          >
            {`{{${v}}}`}
          </code>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Use the pipe syntax for fallbacks: {"{{contact.first_name|there}}"}
      </p>
    </div>
  );
}

function TemplateEditor({
  template,
  variables,
}: {
  template: EmailTemplate;
  variables: readonly string[];
}) {
  const qc = useQueryClient();
  const [subject, setSubject] = useState(template.subject);
  const [bodyHtml, setBodyHtml] = useState(template.body_html);
  const [bodyText, setBodyText] = useState(template.body_text ?? "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<"html" | "text">("html");

  const mutation = useMutation({
    mutationFn: () =>
      patchEmailTemplate(template.id, {
        subject: subject.trim(),
        body_html: bodyHtml.trim(),
        body_text: bodyText.trim() || null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TEMPLATES_KEY });
      setSaved(true);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  // Reset state when template changes (navigating between templates)
  useEffect(() => {
    setSubject(template.subject);
    setBodyHtml(template.body_html);
    setBodyText(template.body_text ?? "");
    setSaved(false);
    setError(null);
  }, [template.id, template.subject, template.body_html, template.body_text]);

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    mutation.mutate();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h3 className="text-[16px] font-semibold text-foreground">{template.name}</h3>
        <Badge variant="muted">{template.slug}</Badge>
        {template.category && <Badge variant="neutral">{template.category}</Badge>}
      </div>

      <VariableReference variables={variables} />

      <form onSubmit={handleSave} className="space-y-4" noValidate>
        <div>
          <label className="mb-1.5 block text-[14px] font-medium text-foreground">
            Subject line
          </label>
          <Input
            value={subject}
            onChange={(e) => { setSubject(e.target.value); setSaved(false); }}
            disabled={mutation.isPending}
          />
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-[14px] font-medium text-foreground">
              Body (HTML)
            </label>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setPreviewMode("html")}
                className={`rounded px-2 py-1 text-[12px] transition-colors duration-(--dur-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${previewMode === "html" ? "bg-selected font-semibold text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                Code
              </button>
              <button
                type="button"
                onClick={() => setPreviewMode("text")}
                className={`rounded px-2 py-1 text-[12px] transition-colors duration-(--dur-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${previewMode === "text" ? "bg-selected font-semibold text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                Plain text
              </button>
            </div>
          </div>

          {previewMode === "html" ? (
            <Textarea
              value={bodyHtml}
              onChange={(e) => { setBodyHtml(e.target.value); setSaved(false); }}
              disabled={mutation.isPending}
              rows={14}
              className="font-mono text-[13px]"
            />
          ) : (
            <Textarea
              value={bodyText}
              onChange={(e) => { setBodyText(e.target.value); setSaved(false); }}
              disabled={mutation.isPending}
              rows={14}
              placeholder="Optional plain-text version. If empty, the system derives it from HTML."
            />
          )}
        </div>

        {/* Live preview. Template HTML is tenant-authored content: it
            renders in a sandboxed frame, never in the dashboard DOM. */}
        <div>
          <p className="mb-1.5 text-[14px] font-medium text-foreground">Preview</p>
          <iframe
            sandbox=""
            referrerPolicy="no-referrer"
            title="Template preview"
            srcDoc={bodyHtml}
            className="h-[360px] w-full rounded-md border border-border bg-white"
          />
        </div>

        {error && (
          <p className="rounded-md border border-danger bg-danger-soft px-3.5 py-2.5 text-[14px] text-foreground">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={mutation.isPending || !subject.trim() || !bodyHtml.trim()}>
            {mutation.isPending ? "Saving..." : "Save template"}
          </Button>
          {saved && (
            <span className="text-[14px] text-muted-foreground" role="status">Saved.</span>
          )}
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TemplatesPage() {
  const { data, isLoading } = useQuery({
    queryKey: TEMPLATES_KEY,
    queryFn: fetchEmailTemplates,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageHeader eyebrow="Content" title="Email Templates" subtitle="Edit the content of your email templates." />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const templates = data?.templates ?? [];
  const variables = data?.supported_variables ?? [];

  if (templates.length === 0) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageHeader eyebrow="Content" title="Email Templates" subtitle="Edit the content of your email templates." />
        <EmptyState
          icon={Mail}
          title="No email templates yet"
          description="Templates hold the fixed copy of library flows. Install the Welcome flow from the Home page to create your first templates."
          action={
            <Link to="/home">
              <Button size="sm" variant="outline">
                Go to Home
              </Button>
            </Link>
          }
        />
      </div>
    );
  }

  const selected = selectedId ? templates.find((t) => t.id === selectedId) : templates[0];

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader eyebrow="Content" title="Email Templates" subtitle="Edit the content of your email templates." />

      <div className="flex gap-6">
        {/* Template list sidebar */}
        <nav className="w-56 shrink-0 space-y-1">
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSelectedId(t.id)}
              className={[
                "w-full rounded-md px-3 py-2 text-left text-[13px] transition-colors",
                (selected?.id === t.id)
                  ? "bg-selected font-semibold text-foreground"
                  : "text-muted-foreground hover:bg-sunken hover:text-foreground",
              ].join(" ")}
            >
              {t.name}
            </button>
          ))}
        </nav>

        {/* Editor */}
        <div className="min-w-0 flex-1 rounded-lg border border-border bg-card p-6">
          {selected ? (
            <TemplateEditor template={selected} variables={variables} />
          ) : (
            <p className="text-muted-foreground">Select a template to edit.</p>
          )}
        </div>
      </div>
    </div>
  );
}
