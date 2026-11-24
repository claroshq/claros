/**
 * Inline template editor - edits subject, body HTML, and body text for a
 * single email template.
 *
 * Used inside the flow editor to edit step content without leaving the flow.
 * This is a detail of a flow, not a standalone destination.
 */
import React, { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Textarea } from "./ui/textarea.js";
import { Badge } from "./ui/badge.js";
import { Skeleton } from "./ui/skeleton.js";

// ---------------------------------------------------------------------------
// Types and API
// ---------------------------------------------------------------------------

export interface EmailTemplate {
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

export const TEMPLATES_QUERY_KEY = ["email-templates"] as const;

export async function fetchEmailTemplates(): Promise<EmailTemplatesResponse> {
  const res = await fetch("/v1/email-templates", { credentials: "include" });
  if (!res.ok) throw new Error(`Failed to load templates (${res.status})`);
  return res.json();
}

async function patchEmailTemplate(
  id: string,
  data: { subject?: string; body_html?: string; body_text?: string | null },
): Promise<{ template: EmailTemplate }> {
  const res = await fetch(`/v1/email-templates/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
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
// Sub-components
// ---------------------------------------------------------------------------

function VariableReference({ variables }: { variables: readonly string[] }) {
  return (
    <div className="rounded-md border border-border bg-sunken p-3">
      <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
        Available variables
      </p>
      <div className="flex flex-wrap gap-1.5">
        {variables.map((v) => (
          <code
            key={v}
            className="rounded bg-bg-raised px-2 py-0.5 font-mono text-[12px] text-foreground border border-border"
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

// ---------------------------------------------------------------------------
// Single template editor (inline, used from the flow editor)
// ---------------------------------------------------------------------------

export function TemplateEditorInline({
  template,
  variables,
  onClose,
}: {
  template: EmailTemplate;
  variables: readonly string[];
  onClose: () => void;
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
      void qc.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
      setSaved(true);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-[16px] font-semibold text-foreground">{template.name}</h3>
          <Badge variant="muted">{template.slug}</Badge>
          {template.category && <Badge variant="neutral">{template.category}</Badge>}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
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
                className={`rounded px-2 py-1 text-[12px] ${previewMode === "html" ? "bg-selected font-semibold text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                Code
              </button>
              <button
                type="button"
                onClick={() => setPreviewMode("text")}
                className={`rounded px-2 py-1 text-[12px] ${previewMode === "text" ? "bg-selected font-semibold text-foreground" : "text-muted-foreground hover:text-foreground"}`}
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

        {/* Live preview */}
        <div>
          <p className="mb-1.5 text-[14px] font-medium text-foreground">Preview</p>
          <div className="rounded-md border border-border bg-white p-4 text-[14px]">
            <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />
          </div>
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
// Template editor loader - resolves a slug to a template and renders the editor
// ---------------------------------------------------------------------------

export function TemplateEditorBySlug({
  slug,
  onClose,
}: {
  slug: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: TEMPLATES_QUERY_KEY,
    queryFn: fetchEmailTemplates,
  });

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const templates = data?.templates ?? [];
  const variables = data?.supported_variables ?? [];
  const template = templates.find((t) => t.slug === slug);

  if (!template) {
    return (
      <div className="p-4">
        <div className="flex items-center justify-between">
          <p className="text-[14px] text-muted-foreground">
            Template <code className="font-mono">{slug}</code> not found.
          </p>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <TemplateEditorInline template={template} variables={variables} onClose={onClose} />
  );
}
