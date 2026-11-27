/**
 * Template studio: edit one email template by describing changes in a
 * chat. The preview sits on the left, the chat is docked on the right
 * (below on small screens). While a change is applied the preview is
 * frosted; the new version replaces it when the model answers.
 *
 * The working copy lives in sessionStorage per product and template, so
 * several templates can be in progress at once and a reload keeps the
 * chat. Nothing reaches the product until Save. A built-in template is
 * saved as a new custom template.
 *
 * The assistant only works on this template (enforced by the server
 * prompt) and knows mail client support: it declines changes that would
 * break Outlook, Gmail, Apple Mail or Yahoo and proposes a version that
 * works. Its answers are text; model-authored HTML only ever renders in
 * the sandboxed preview frame.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowUp, Code2, ListChecks, Monitor, Smartphone, Sparkles, Undo2 } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Badge } from "../components/ui/badge.js";
import { Input } from "../components/ui/input.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { useLayout, useSaveLayout, useUseLayout } from "../layouts.js";
import { assistLayout, previewLayout, LayoutApiError, type LayoutFinding, type LayoutWidth, type StudioDecision, type StudioTurn } from "../api.js";
import { selectedProductSlug } from "../product.js";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  decision?: StudioDecision;
  /** Findings this change introduced (messages for display). */
  introduced?: LayoutFinding[];
  /** Local notes (errors, intro) are never sent to the model. */
  local?: boolean;
}

interface Session {
  source: string;
  width: LayoutWidth;
  name: string;
  messages: ChatMessage[];
  undo: string[];
}

const SUGGESTIONS = [
  "Make the body text 16px with more line spacing",
  "Center the logo and make the header band darker",
  "Round the corners of the card",
  "Add a thin accent rule above the footer",
];

const INTRO =
  "Describe a change to this template and I will apply it. I know how Outlook, Gmail, Apple Mail and Yahoo render email: if something you ask for would break in one of them, I will say so and suggest a version that works everywhere. The message text itself comes from your flows; here we shape the design around it.";

function storageKey(ref: string): string {
  return `claros.studio:${selectedProductSlug() ?? "default"}:${ref}`;
}

function loadSession(ref: string): Session | null {
  try {
    const raw = sessionStorage.getItem(storageKey(ref));
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function saveSession(ref: string, s: Session | null) {
  try {
    if (s) sessionStorage.setItem(storageKey(ref), JSON.stringify(s));
    else sessionStorage.removeItem(storageKey(ref));
  } catch {
    // storage full or unavailable: the session just does not survive a reload
  }
}

const DECISION_BADGE: Partial<Record<StudioDecision, { tone: "success" | "warning" | "muted" | "danger"; label: string }>> = {
  applied: { tone: "success", label: "Applied" },
  proposed: { tone: "warning", label: "Needs your answer" },
  off_topic: { tone: "muted", label: "Out of scope" },
  failed: { tone: "danger", label: "Not applied" },
};

function FindingList({ findings }: { findings: LayoutFinding[] }) {
  if (findings.length === 0) {
    return <p className="text-[14px] text-muted-foreground">No issues found for Outlook, Gmail, Apple Mail or Yahoo.</p>;
  }
  const order = { error: 0, warning: 1, info: 2 } as const;
  return (
    <ul className="space-y-3">
      {[...findings].sort((a, b) => order[a.severity] - order[b.severity]).map((f, i) => (
        <li key={`${f.rule}-${i}`} className="text-[14px] leading-[22px]">
          <div className="flex items-start gap-2">
            <Badge variant={f.severity === "error" ? "danger" : f.severity === "warning" ? "warning" : "neutral"}>
              {f.severity === "error" ? "Blocks saving" : f.severity === "warning" ? "Warning" : "Note"}
            </Badge>
            <span className="pt-0.5 text-foreground">{f.message}</span>
          </div>
          {f.clients.length > 0 && <p className="mt-1 text-muted-foreground">Affects: {f.clients.join(", ")}</p>}
          <p className="mt-0.5 text-muted-foreground">{f.fix}</p>
        </li>
      ))}
    </ul>
  );
}

export function LayoutStudioPage() {
  const { ref = "classic" } = useParams();
  const navigate = useNavigate();
  const q = useLayout(ref);
  const save = useSaveLayout();
  const use = useUseLayout();

  const [session, setSession] = useState<Session | null>(null);
  const [restored, setRestored] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string>("");
  const [findings, setFindings] = useState<LayoutFinding[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [view, setView] = useState<"preview" | "html">("preview");
  const [showChecks, setShowChecks] = useState(false);
  const [htmlDraft, setHtmlDraft] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ message: string; findings: LayoutFinding[] } | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [noLlm, setNoLlm] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const saved = q.data?.template;

  // Start (or resume) the session once the saved template is loaded.
  useEffect(() => {
    if (!saved) return;
    const stored = loadSession(ref);
    if (stored && (stored.source !== saved.source || stored.messages.length > 0)) {
      setSession(stored);
      setRestored(stored.source !== saved.source);
      void previewLayout(stored.source, stored.width).then((p) => { setPreviewHtml(p.html); setFindings(p.findings); }).catch(() => undefined);
    } else {
      setSession({ source: saved.source, width: saved.width, name: saved.name, messages: [], undo: [] });
      setPreviewHtml(q.data!.preview_html);
      setFindings(q.data!.findings);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved?.ref, saved?.updated_at]);

  useEffect(() => {
    if (session) saveSession(ref, session);
  }, [ref, session]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "end" });
  }, [session?.messages.length, pending]);

  const dirty = !!(session && saved && (session.source !== saved.source || session.name !== saved.name || session.width !== saved.width));

  // Warn before leaving the page with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const refreshPreview = useCallback(async (source: string, width: LayoutWidth) => {
    const p = await previewLayout(source, width);
    setPreviewHtml(p.html);
    setFindings(p.findings);
  }, []);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || !session || pending) return;
    setInput("");
    setSavedNote(null);
    const history: StudioTurn[] = session.messages.filter((m) => !m.local).map((m) => ({ role: m.role, content: m.content }));
    const withUser: Session = { ...session, messages: [...session.messages, { role: "user", content: message }] };
    setSession(withUser);
    setPending(true);
    try {
      const r = await assistLayout({ source: session.source, width: session.width, message, history });
      const introduced = r.findings.filter((f) => r.new_findings.includes(f.rule));
      const reply: ChatMessage = { role: "assistant", content: r.reply, decision: r.decision, introduced };
      setSession((s) => {
        const base = s ?? withUser;
        if (r.decision === "applied" && r.source) {
          return { ...base, source: r.source, undo: [...base.undo, base.source].slice(-30), messages: [...base.messages, reply] };
        }
        return { ...base, messages: [...base.messages, reply] };
      });
      if (r.decision === "applied" && r.preview_html) {
        setPreviewHtml(r.preview_html);
        setFindings(r.findings);
        setHtmlDraft(null);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof LayoutApiError && e.status === 422) setNoLlm(true);
      setSession((s) => (s ? { ...s, messages: [...s.messages, { role: "assistant", content: msg, decision: "failed", local: true }] } : s));
    } finally {
      setPending(false);
      inputRef.current?.focus();
    }
  };

  const undo = async () => {
    if (!session || session.undo.length === 0 || pending) return;
    const previous = session.undo[session.undo.length - 1]!;
    setSession({ ...session, source: previous, undo: session.undo.slice(0, -1), messages: [...session.messages, { role: "assistant", content: "Undid the last change.", local: true }] });
    setHtmlDraft(null);
    await refreshPreview(previous, session.width).catch(() => undefined);
  };

  const applyHtml = async () => {
    if (!session || htmlDraft === null || htmlDraft === session.source) return;
    setSession({ ...session, source: htmlDraft, undo: [...session.undo, session.source].slice(-30), messages: [...session.messages, { role: "assistant", content: "Applied your HTML edit.", local: true }] });
    setHtmlDraft(null);
    await refreshPreview(htmlDraft, session.width).catch(() => undefined);
  };

  const setWidth = async (width: LayoutWidth) => {
    if (!session || width === session.width) return;
    setSession({ ...session, width });
    await refreshPreview(session.source, width).catch(() => undefined);
  };

  const discard = async () => {
    if (!saved) return;
    if (!window.confirm("Discard your changes and this chat?")) return;
    const fresh = { source: saved.source, width: saved.width, name: saved.name, messages: [], undo: [] };
    setSession(fresh);
    setRestored(false);
    setHtmlDraft(null);
    await refreshPreview(saved.source, saved.width).catch(() => undefined);
  };

  const doSave = (andUse: boolean) => {
    if (!session || !saved) return;
    setSaveError(null);
    const isBuiltin = saved.kind === "builtin";
    const name = isBuiltin && session.name === saved.name ? `${saved.name} (custom)` : session.name.trim() || saved.name;
    save.mutate(
      { id: isBuiltin ? null : saved.id, name, width: session.width, source: session.source, basedOn: isBuiltin ? saved.ref : saved.based_on },
      {
        onSuccess: (res) => {
          const finish = () => {
            if (isBuiltin) {
              saveSession(ref, null);
              saveSession(res.template.ref, { ...session, name: res.template.name });
              navigate(`/templates/${encodeURIComponent(res.template.ref)}`, { replace: true });
            } else {
              setSession({ ...session, name: res.template.name });
              setRestored(false);
            }
            setSavedNote(andUse ? "Saved. Every email of this product now uses this template." : "Saved.");
          };
          if (andUse) use.mutate(res.template.ref, { onSuccess: finish, onError: (e) => setSaveError({ message: e.message, findings: [] }) });
          else finish();
        },
        onError: (e) => setSaveError({ message: e.message, findings: e instanceof LayoutApiError ? e.findings : [] }),
      },
    );
  };

  const leave = () => {
    if (dirty && !window.confirm("You have unsaved changes. Leave anyway? They stay here until you close the tab.")) return;
    navigate("/templates");
  };

  const counts = useMemo(() => ({
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
  }), [findings]);

  if (q.isLoading) {
    return (
      <div className="flex h-full flex-col gap-4">
        <Skeleton className="h-9 w-72" />
        <div className="flex min-h-0 flex-1 gap-4">
          <Skeleton className="h-full flex-1" />
          <Skeleton className="hidden h-full w-[400px] lg:block" />
        </div>
      </div>
    );
  }

  if (q.isError || !saved || !session) {
    return (
      <div className="mx-auto max-w-6xl">
        <Link to="/templates" className="inline-flex items-center gap-1.5 text-[14px] text-muted-foreground hover:text-foreground">
          <ArrowLeft size={16} strokeWidth={1.5} /> Templates
        </Link>
        <div className="mt-6 rounded-md border border-danger bg-danger-soft px-4 py-3 text-[15px] text-foreground" role="alert">
          {q.error?.message ?? "Template not found."}
        </div>
      </div>
    );
  }

  const isBuiltin = saved.kind === "builtin";

  return (
    <div className="flex h-full min-h-[600px] flex-col">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 pb-4">
        <button type="button" onClick={leave} className="inline-flex items-center gap-1.5 rounded-md text-[14px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ArrowLeft size={16} strokeWidth={1.5} /> Templates
        </button>
        <Input
          aria-label="Template name"
          value={session.name}
          onChange={(e) => setSession({ ...session, name: e.target.value })}
          className="h-9 w-56 font-medium"
        />
        <Badge variant={isBuiltin ? "muted" : "accent"}>{isBuiltin ? "Built-in" : "Custom"}</Badge>
        {saved.in_use && <Badge variant="success">In use</Badge>}
        {dirty && <Badge variant="warning">Unsaved changes</Badge>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => void undo()} disabled={session.undo.length === 0 || pending} aria-label="Undo last change">
            <Undo2 strokeWidth={1.5} /> Undo
          </Button>
          {dirty && (
            <Button size="sm" variant="ghost" onClick={() => void discard()} disabled={pending}>
              Discard
            </Button>
          )}
          {(!saved.in_use || dirty) && (
            <Button size="sm" variant="outline" onClick={() => doSave(true)} disabled={pending || save.isPending || use.isPending || counts.errors > 0}>
              {isBuiltin && !dirty ? "Use for this product" : "Save and use"}
            </Button>
          )}
          {(dirty || !isBuiltin) && (
            <Button size="sm" onClick={() => doSave(false)} disabled={pending || save.isPending || !dirty || counts.errors > 0}>
              {save.isPending ? "Saving..." : isBuiltin ? "Save as new template" : "Save"}
            </Button>
          )}
        </div>
      </div>

      {(saveError || savedNote || restored) && (
        <div className="pb-3">
          {saveError && (
            <div className="rounded-md border border-danger bg-danger-soft px-4 py-3 text-[15px] text-foreground" role="alert">
              <p>{saveError.message}</p>
              {saveError.findings.length > 0 && <div className="mt-2"><FindingList findings={saveError.findings} /></div>}
            </div>
          )}
          {savedNote && <p className="text-[14px] text-success" role="status">{savedNote}</p>}
          {restored && !saveError && !savedNote && (
            <p className="text-[14px] text-muted-foreground" role="status">Restored your unsaved changes from earlier in this tab.</p>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        {/* Preview */}
        <section className="flex min-h-[320px] min-w-0 flex-1 flex-col rounded-lg border border-border bg-sunken" aria-label="Template preview">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <div className="inline-flex rounded-md border border-border bg-background p-0.5" role="tablist" aria-label="View">
              {(["preview", "html"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-[14px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${view === v ? "bg-sunken text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {v === "preview" ? <Sparkles size={14} strokeWidth={1.5} /> : <Code2 size={14} strokeWidth={1.5} />}
                  {v === "preview" ? "Preview" : "HTML"}
                </button>
              ))}
            </div>
            {view === "preview" && (
              <div className="inline-flex rounded-md border border-border bg-background p-0.5" role="group" aria-label="Device">
                {(["desktop", "mobile"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={device === d}
                    aria-label={d === "desktop" ? "Desktop width" : "Phone width"}
                    onClick={() => setDevice(d)}
                    className={`inline-flex h-7 w-8 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${device === d ? "bg-sunken text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    {d === "desktop" ? <Monitor size={14} strokeWidth={1.5} /> : <Smartphone size={14} strokeWidth={1.5} />}
                  </button>
                ))}
              </div>
            )}
            <label className="flex items-center gap-1.5 text-[14px] text-muted-foreground">
              Width
              <select
                value={session.width}
                onChange={(e) => void setWidth(e.target.value as LayoutWidth)}
                disabled={pending}
                className="h-7 rounded-sm border border-input bg-card px-1.5 text-[14px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="narrow">Narrow</option>
                <option value="wide">Wide</option>
              </select>
            </label>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setShowChecks((v) => !v)} aria-expanded={showChecks}>
              <ListChecks strokeWidth={1.5} />
              Client checks
              {(counts.errors > 0 || counts.warnings > 0) && (
                <Badge variant={counts.errors > 0 ? "danger" : "warning"}>{counts.errors + counts.warnings}</Badge>
              )}
            </Button>
          </div>

          {showChecks && (
            <div className="max-h-56 overflow-y-auto border-b border-border bg-background px-4 py-3">
              <FindingList findings={findings} />
            </div>
          )}

          <div className="relative min-h-0 flex-1 overflow-hidden">
            {view === "preview" ? (
              <div className="flex h-full justify-center overflow-auto p-4">
                <iframe
                  sandbox=""
                  referrerPolicy="no-referrer"
                  title="Template preview"
                  srcDoc={previewHtml}
                  className="h-full min-h-[480px] rounded-md border border-border bg-white transition-[width] duration-(--dur-med)"
                  style={{ width: device === "mobile" ? 390 : "100%" }}
                />
              </div>
            ) : (
              <div className="flex h-full flex-col gap-2 p-3">
                <textarea
                  aria-label="Template HTML"
                  spellCheck={false}
                  value={htmlDraft ?? session.source}
                  onChange={(e) => setHtmlDraft(e.target.value)}
                  disabled={pending}
                  className="min-h-0 flex-1 resize-none rounded-md border border-input bg-card p-3 font-mono text-[13px] leading-[20px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                {htmlDraft !== null && htmlDraft !== session.source && (
                  <div className="flex items-center gap-2">
                    <Button size="sm" onClick={() => void applyHtml()}>Apply HTML</Button>
                    <Button size="sm" variant="ghost" onClick={() => setHtmlDraft(null)}>Cancel</Button>
                  </div>
                )}
              </div>
            )}

            {/* Frosted overlay while a change is applied */}
            <div
              className={`absolute inset-0 flex items-center justify-center bg-background/50 backdrop-blur-[6px] transition-opacity duration-(--dur-med) ${pending ? "opacity-100" : "pointer-events-none opacity-0"}`}
              aria-hidden={!pending}
            >
              <div className="flex items-center gap-3 rounded-lg border border-border bg-card shadow-card px-4 py-3 text-[15px] text-foreground shadow-overlay" role="status">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-border-strong border-t-accent" aria-hidden="true" />
                Applying your change...
              </div>
            </div>
          </div>
        </section>

        {/* Chat */}
        <section className="flex h-[46vh] min-h-[320px] flex-col rounded-lg border border-border bg-card shadow-card lg:h-auto lg:w-[400px] lg:shrink-0" aria-label="Template studio chat">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Sparkles size={16} strokeWidth={1.5} className="text-accent-text" />
            <p className="text-[15px] font-medium text-foreground">Template studio</p>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
            <div className="text-[15px] leading-[24px] text-muted-foreground">{INTRO}</div>
            {session.messages.length === 0 && (
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={pending || noLlm}
                    onClick={() => void send(s)}
                    className="rounded-md border border-border bg-background px-2.5 py-1.5 text-left text-[14px] text-foreground transition-colors duration-(--dur-fast) hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:text-muted-foreground"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {session.messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="ml-8 rounded-lg bg-accent-soft px-3 py-2 text-[15px] leading-[24px] whitespace-pre-wrap text-foreground">
                  {m.content}
                </div>
              ) : (
                <div key={i} className="mr-4 text-[15px] leading-[24px] text-foreground">
                  {m.decision && DECISION_BADGE[m.decision] && (
                    <Badge variant={DECISION_BADGE[m.decision]!.tone} className="mb-1.5">{DECISION_BADGE[m.decision]!.label}</Badge>
                  )}
                  <p className="whitespace-pre-wrap">{m.content}</p>
                  {m.introduced && m.introduced.length > 0 && (
                    <ul className="mt-2 space-y-1 text-[14px] text-muted-foreground">
                      {m.introduced.map((f) => (
                        <li key={f.rule}>New: {f.message}{f.clients.length ? ` (${f.clients.join(", ")})` : ""}</li>
                      ))}
                    </ul>
                  )}
                  {m.decision === "proposed" && i === session.messages.length - 1 && !pending && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => void send("Yes, apply what you proposed.")}>Apply the proposal</Button>
                      <Button size="sm" variant="ghost" onClick={() => void send("No, leave the template as it is.")}>Leave it</Button>
                    </div>
                  )}
                </div>
              ),
            )}
            {pending && (
              <div className="flex items-center gap-1.5 text-[14px] text-muted-foreground" role="status">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
                Working on it
              </div>
            )}
            <div ref={chatEnd} />
          </div>
          {noLlm && (
            <p className="mx-4 mb-2 rounded-md border border-border bg-sunken px-3 py-2 text-[14px] text-muted-foreground">
              The studio uses this product's LLM provider. <Link to="/settings/llm" className="text-accent-text underline">Add one in Settings, AI providers</Link>.
            </p>
          )}
          <form
            className="flex items-end gap-2 border-t border-border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <textarea
              ref={inputRef}
              aria-label="Describe a change"
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              placeholder="Describe a change, e.g. make the header band dark navy"
              disabled={pending}
              maxLength={4000}
              className="max-h-40 min-h-[44px] flex-1 resize-none rounded-md border border-input bg-card px-3 py-2 text-[15px] text-foreground placeholder:text-subtle-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:bg-sunken"
            />
            <Button type="submit" size="icon" disabled={pending || input.trim() === ""} aria-label="Send">
              <ArrowUp strokeWidth={1.75} />
            </Button>
          </form>
        </section>
      </div>
    </div>
  );
}
