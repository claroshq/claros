/**
 * Flow editor (/flows/new and /flows/:id/edit).
 *
 * The flow reads as a timeline: what starts it, each email with the wait
 * before it, and what ends it early. Selecting a node opens its editor
 * beside the timeline. Delivery settings (review, topic, class, priority,
 * re-entry) live on their own tab.
 *
 * One draft, one save. Every edit on the page goes into a single draft;
 * the save bar shows when it differs from what is stored. Saving writes the
 * differences in order: PATCH /v1/flows/:id (name, trigger, prompt,
 * settings, content_mode), PUT /v1/email-templates/by-slug/:slug for each
 * changed fixed copy, then PUT /v1/flows/:id/steps for the steps and exits.
 * A new flow is created with POST /v1/flows first. An active flow keeps
 * running on the stored version until the save completes.
 *
 * The steps keep the config document shape, so a flow applied from a config
 * file shows its real emails here (template copy, AI instruction, choose
 * candidates) and saves back the same shape. Flows managed by config as
 * code say so: the next `claros apply` of the document replaces edits.
 *
 * Prompt-defined flows keep their prompt as a timeline node: compiling
 * (POST /v1/flows/:id/compile, polled every 3 s) replaces the emails.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Pause, Play, X } from "lucide-react";
import {
  compileFlow,
  createFlow,
  putEmailTemplateBySlug,
  saveFlowSteps,
  updateFlow,
  type EmailTemplateRow,
  type Flow,
  type FlowApiError,
  type StepCopy,
  type UpdateFlowInput,
} from "../api.js";
import {
  EMAIL_TEMPLATE_ROWS_KEY,
  FLOWS_QUERY_KEY,
  FLOW_EDITOR_CONTEXT_KEY,
  flowQueryKey,
  useArchiveFlow,
  useCompileFlow,
  useEmailTemplateRows,
  useEventNames,
  useFlowEditorContext,
  useFlowStatus,
  useFlowWithPolling,
} from "../flows.js";
import { useTopics } from "../topics-transports.js";
import { useLayoutList } from "../layouts.js";
import { useTenant } from "../settings.js";
import { useKbEntries } from "../kb.js";
import { cleanTriggerConfig, LIFECYCLE_STATES, type Json, type TriggerDraft } from "../lib/flow-model.js";
import {
  contentModeFor,
  describeDelay,
  draftChanges,
  draftFromFlow,
  draftProblems,
  emptyDraft,
  hasChanges,
  moveStep,
  newCopySlug,
  newStep,
  planBody,
  sortSteps,
  stepMode,
  summarizeFlow,
  switchStepMode,
  type DraftProblem,
  type EditorDraft,
} from "../lib/flow-editor-model.js";
import { RECIPES, draftFromRecipe, type Recipe } from "../lib/flow-recipes.js";
import { FlowTimeline, type Selection } from "../components/flow-editor/flow-timeline.js";
import { StepPanel, type EditorEnv } from "../components/flow-editor/step-panel.js";
import { DeliverySettings, ExitsPanel, PromptPanel, TriggerPanel } from "../components/flow-editor/side-panels.js";
import { sampleValues } from "../components/flow-editor/email-preview.js";
import { Button } from "../components/ui/button.js";
import { Badge, type BadgeVariant } from "../components/ui/badge.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Textarea } from "../components/ui/textarea.js";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function statusVariant(status: Flow["status"]): BadgeVariant {
  switch (status) {
    case "active": return "success";
    case "draft": return "neutral";
    case "paused": return "warning";
    case "archived": return "muted";
  }
}

function errorText(err: unknown): string {
  if (err !== null && typeof err === "object" && "kind" in err) {
    const e = err as FlowApiError;
    if (e.kind === "validation") return e.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ");
    return e.message;
  }
  return err instanceof Error ? err.message : "Saving failed.";
}

const TENURE = ["new", "growing", "established", "loyal"];
const RECENCY = ["active", "cooling", "idle", "dormant"];

/** Prefill from the retention grid: ?segment=tenure:recency or ?transition=from:to (&name=). */
function prefillFromSearch(params: URLSearchParams): EditorDraft | null {
  const segment = params.get("segment");
  if (segment) {
    const [tenure, recency] = segment.split(":");
    if (tenure && recency && TENURE.includes(tenure) && RECENCY.includes(recency)) {
      return { ...emptyDraft({ type: "segment", config: { tenure_bucket: tenure, recency_bucket: recency } }), name: params.get("name") ?? `${tenure} · ${recency}` };
    }
  }
  const transition = params.get("transition");
  if (transition) {
    const [from, to] = transition.split(":");
    const states: readonly string[] = LIFECYCLE_STATES;
    if (from && to && states.includes(from) && states.includes(to)) {
      return { ...emptyDraft({ type: "lifecycle_transition", config: { from, to } }), name: params.get("name") ?? "" };
    }
  }
  return null;
}

function FlowNameInput({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <input
      id="flow-name"
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Name this flow"
      disabled={disabled}
      aria-label="Flow name"
      className="-ml-2 w-full min-w-0 rounded-md bg-transparent px-2 py-1 font-display text-[34px] font-bold leading-[40px] tracking-[-0.025em] text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 hover:bg-sunken focus:bg-sunken disabled:hover:bg-transparent sm:text-[28px] sm:leading-[34px]"
    />
  );
}

// ---------------------------------------------------------------------------
// Header actions
// ---------------------------------------------------------------------------

function MoreMenu({ items }: { items: Array<{ label: string; onClick: () => void; danger?: boolean }> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <Button type="button" variant="ghost" size="icon" aria-label="More actions" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <MoreHorizontal />
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1 w-56 rounded-lg border border-border bg-card shadow-card p-1 shadow-(--overlay-shadow)">
          {items.map((i) => (
            <button
              key={i.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                i.onClick();
              }}
              className={`block w-full rounded-md px-3 py-2 text-left text-[15px] hover:bg-sunken ${i.danger ? "text-danger" : "text-foreground"}`}
            >
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// New flow: start screen
// ---------------------------------------------------------------------------

function StartScreen({ hasLlm, dateTraits, onPick }: { hasLlm: boolean; dateTraits: string[]; onPick: (draft: EditorDraft, select: Selection) => void }) {
  const [prompt, setPrompt] = useState("");
  const pickRecipe = (r: Recipe) => onPick(draftFromRecipe(r, () => newCopySlug()), 0);
  return (
    <div className="mx-auto max-w-5xl">
      <Link to="/flows" className="text-[15px] text-muted-foreground transition-colors hover:text-foreground">&larr; Flows</Link>
      <h1 className="mt-3 font-display text-[34px] font-bold leading-[40px] tracking-[-0.025em] text-foreground">New flow</h1>
      <p className="mt-1 max-w-2xl text-[16px] text-muted-foreground">
        A flow sends a short sequence of emails to the contacts who match its trigger. Start from an example and change it, or describe what you want.
      </p>

      <h2 className="mt-8 text-[17px] font-semibold text-foreground">Start from an example</h2>
      <p className="mt-0.5 text-[15px] text-muted-foreground">Each fills the trigger and the emails with sample copy you edit before saving. Nothing sends until you activate the flow.</p>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {RECIPES.map((r) => {
          const blocked = r.needsLlm === true && !hasLlm;
          return (
            <button
              key={r.id}
              type="button"
              disabled={blocked}
              onClick={() => pickRecipe(r)}
              className="rounded-xl border border-border bg-card shadow-card p-4 text-left transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border"
            >
              <span className="flex items-center gap-2">
                <span className="text-[16px] font-semibold text-foreground">{r.title}</span>
                {r.needsLlm && <Badge variant="accent">AI drafted</Badge>}
              </span>
              <span className="mt-1 block text-[15px] leading-relaxed text-muted-foreground">{r.description}</span>
              <span className="mt-3 flex flex-wrap gap-1">
                {r.build().emails.map((e, i) => (
                  <span key={i} className="rounded bg-sunken px-1.5 py-0.5 text-[13px] text-muted-foreground">
                    {i === 0 ? describeDelay(e.delay) : `then ${describeDelay(e.delay)}`}
                  </span>
                ))}
              </span>
              {blocked && <span className="mt-2 block text-[13px] text-muted-foreground">Needs an LLM provider (Settings, LLM).</span>}
              {r.needsDateTrait && dateTraits.length === 0 && (
                <span className="mt-2 block text-[13px] text-muted-foreground">Needs a date trait such as trial_ends_at in settings.date_traits.</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="rounded-xl border border-border bg-card shadow-card p-5">
          <h2 className="text-[17px] font-semibold text-foreground">Or describe it</h2>
          <p className="mt-0.5 text-[15px] text-muted-foreground">Claros compiles the description into emails you can read and change before anything sends.</p>
          <Textarea
            aria-label="Describe the flow"
            className="mt-3 text-[16px] leading-relaxed"
            rows={5}
            value={prompt}
            disabled={!hasLlm}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="When someone signs up on the free plan, welcome them right away. If they have not created a project after a day, show them the two-minute setup. Two days later, send one tip. Stop as soon as they upgrade."
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button type="button" disabled={!hasLlm || prompt.trim() === ""} onClick={() => onPick({ ...emptyDraft(), prompt: prompt.trim() }, "trigger")}>
              Continue
            </Button>
            <span className="text-[14px] text-muted-foreground">{hasLlm ? "Next: pick the trigger, then create the flow to compile." : "Needs an LLM provider (Settings, LLM)."}</span>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card shadow-card p-5">
          <h2 className="text-[17px] font-semibold text-foreground">Or start blank</h2>
          <p className="mt-0.5 text-[15px] text-muted-foreground">Pick a trigger and write the emails yourself.</p>
          <Button type="button" variant="outline" className="mt-3" onClick={() => onPick(emptyDraft(), "trigger")}>
            Start blank
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The workspace
// ---------------------------------------------------------------------------

interface WorkspaceProps {
  flow?: Flow;
  initialDraft: EditorDraft;
  initialSelection: Selection;
  templates: EmailTemplateRow[];
  initialError?: string | null;
}

function stampOf(f: Flow): string {
  return `${f.updated_at}|${f.compiled_at ?? ""}|${f.compile_status ?? ""}`;
}

function FlowWorkspace({ flow, initialDraft, initialSelection, templates, initialError = null }: WorkspaceProps) {
  const isNew = !flow;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const ctx = useFlowEditorContext();
  const eventNames = useEventNames();
  const topics = useTopics();
  const layouts = useLayoutList();
  const tenant = useTenant();
  const kb = useKbEntries(false);
  const statusMutation = useFlowStatus(flow?.id ?? "");
  const archiveMutation = useArchiveFlow(flow?.id ?? "");
  const compileMutation = useCompileFlow(flow?.id ?? "");

  const [saved, setSaved] = useState<EditorDraft>(() => (flow ? draftFromFlow(flow) : emptyDraft()));
  const [draft, setDraft] = useState<EditorDraft>(initialDraft);
  const [selected, setSelected] = useState<Selection>(initialSelection);
  const [tab, setTab] = useState<"emails" | "settings">("emails");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [showProblems, setShowProblems] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [json, setJson] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [configNoticeDismissed, setConfigNoticeDismissed] = useState(readConfigNoticeDismissed);
  const dismissConfigNotice = () => {
    setConfigNoticeDismissed(true);
    try {
      localStorage.setItem(CONFIG_NOTICE_KEY, "1");
    } catch {
      // Storage unavailable (private mode): dismissed for this visit only.
    }
  };
  const [compileError, setCompileError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const templateMap = useMemo(() => new Map(templates.map((t) => [t.slug, t])), [templates]);
  const copyOf = useCallback(
    (slug: string): StepCopy | undefined => {
      const c = draft.copies[slug];
      if (c) return c;
      const t = templateMap.get(slug);
      return t ? { subject: t.subject, body_html: t.body_html, body_text: t.body_text } : undefined;
    },
    [draft.copies, templateMap],
  );

  // Copies typed back to what is stored are not changes.
  const effectiveDraft = useMemo<EditorDraft>(() => {
    const copies: Record<string, StepCopy> = {};
    for (const [slug, c] of Object.entries(draft.copies)) {
      const t = templateMap.get(slug);
      if (!t || t.subject !== c.subject || t.body_html !== c.body_html || (t.body_text ?? null) !== (c.body_text ?? null)) copies[slug] = c;
    }
    return { ...draft, copies };
  }, [draft, templateMap]);

  const changes = useMemo(() => draftChanges(saved, effectiveDraft, cleanTriggerConfig), [saved, effectiveDraft]);
  const dirty = isNew || hasChanges(changes);
  const problems = useMemo(() => draftProblems(draft, copyOf), [draft, copyOf]);

  // A flow that changed on the server (a compile finished, another tab
  // saved) replaces the draft when nothing is being edited here.
  const lastStamp = useRef(flow ? stampOf(flow) : "");
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!flow || stampOf(flow) === lastStamp.current) return;
    lastStamp.current = stampOf(flow);
    const next = draftFromFlow(flow);
    setSaved(next);
    if (!dirtyRef.current) setDraft(next);
  }, [flow]);

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty || (isNew && draft.steps.length === 0 && draft.name === "")) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty, isNew, draft.steps.length, draft.name]);

  const archived = flow?.status === "archived";
  const disabled = archived || saving;
  const hasLlm = ctx.data?.has_llm ?? false;
  const links = useMemo(() => ctx.data?.links ?? [], [ctx.data]);
  const kbCategories = useMemo(() => {
    const set = new Set<string>();
    for (const page of kb.data?.pages ?? []) for (const e of page.entries) if (e.category) set.add(e.category);
    return [...set].sort();
  }, [kb.data]);
  const sample = useMemo(() => sampleValues(tenant.data?.tenant.name ?? "", draft.name, links), [tenant.data, draft.name, links]);

  const problemsAt = (where: Selection) => (showProblems ? problems.filter((p) => p.where === where).length : 0);
  const problemTexts = (where: DraftProblem["where"]) => (showProblems ? problems.filter((p) => p.where === where).map((p) => p.message) : []);

  function select(s: Selection) {
    setSelected(s);
    setTab("emails");
    if (window.matchMedia("(max-width: 1023px)").matches) {
      requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }

  function update(patch: Partial<EditorDraft>) {
    setNotice(null);
    setDraft((d) => ({ ...d, ...patch }));
  }

  function updateStep(i: number, patch: Json) {
    setNotice(null);
    setDraft((d) => ({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  }

  function addStep(mode: "fixed" | "ai") {
    const slug = newCopySlug();
    const index = draft.steps.length;
    setDraft((d) => {
      const step = newStep(d.steps, mode, slug);
      const copies = mode === "fixed" ? { ...d.copies, [slug]: { subject: "", body_html: "", body_text: null } } : d.copies;
      return { ...d, steps: [...d.steps, step], copies };
    });
    select(index);
  }

  function setMode(i: number, mode: "fixed" | "ai") {
    const slug = newCopySlug();
    setDraft((d) => {
      const step = switchStepMode(d.steps[i]!, mode, slug);
      const ref = typeof step.template_ref === "string" ? step.template_ref : null;
      const copies = ref && !d.copies[ref] && !templateMap.has(ref) ? { ...d.copies, [ref]: { subject: "", body_html: "", body_text: null } } : d.copies;
      return { ...d, steps: d.steps.map((s, j) => (j === i ? step : s)), copies };
    });
  }

  function discard() {
    if (isNew) {
      navigate("/flows");
      return;
    }
    setDraft(saved);
    setError(null);
    setShowProblems(false);
  }

  async function save() {
    setError(null);
    setNotice(null);
    setShowProblems(true);
    const blocking = [...problems];
    if (draft.steps.length === 0 && draft.prompt === null && (isNew || changes.plan)) blocking.push({ where: "trigger", message: "Add at least one email." });
    if (blocking.length > 0) {
      const first = blocking[0]!;
      if (first.where !== "name") select(first.where);
      setError(blocking.length === 1 ? first.message : `${blocking.length} things to fix before saving. First: ${first.message}`);
      return;
    }
    setSaving(true);
    const copyName = (slug: string) => {
      const i = draft.steps.findIndex((s) => s.template_ref === slug);
      return templateMap.has(slug) ? undefined : `${draft.name.trim()} - email ${i + 1}`;
    };
    let flowId = flow?.id;
    try {
      let current: Flow | undefined = flow;
      if (!flowId) {
        current = await createFlow({
          name: draft.name.trim(),
          trigger_type: draft.trigger.type,
          trigger_config: cleanTriggerConfig(draft.trigger),
          content_mode: contentModeFor(draft),
          steps: [],
          approval_mode: draft.approval_mode,
          flow_class: draft.flow_class,
          priority: draft.priority,
          reentry_policy: draft.reentry_policy,
          reentry_cooldown_days: draft.reentry_cooldown_days,
          topic_id: draft.topic_id,
          email_template: draft.email_template,
          ...(draft.prompt !== null ? { prompt_source: draft.prompt } : {}),
        });
        flowId = current.id;
      } else {
        const patch = { ...changes.patch } as UpdateFlowInput;
        const mode = contentModeFor(draft);
        if (mode !== flow!.content_mode && draft.steps.length > 0) patch.content_mode = mode;
        if (Object.keys(patch).length > 0) current = await updateFlow(flowId, patch);
      }
      const written: EmailTemplateRow[] = [];
      const copies = isNew
        ? Object.fromEntries(Object.entries(draft.copies).filter(([slug]) => draft.steps.some((s) => s.template_ref === slug)))
        : changes.copies;
      for (const [slug, c] of Object.entries(copies)) {
        const name = copyName(slug);
        written.push(await putEmailTemplateBySlug(slug, { ...c, ...(name ? { name } : {}) }));
      }
      if ((isNew && draft.steps.length > 0) || (!isNew && changes.plan)) {
        current = await saveFlowSteps(flowId, planBody(draft));
      }
      if (written.length > 0) {
        qc.setQueryData<EmailTemplateRow[]>(EMAIL_TEMPLATE_ROWS_KEY, (rows = []) => [...rows.filter((r) => !written.some((w) => w.slug === r.slug)), ...written]);
      }
      void qc.invalidateQueries({ queryKey: FLOWS_QUERY_KEY, exact: true });
      void qc.invalidateQueries({ queryKey: FLOW_EDITOR_CONTEXT_KEY });
      if (isNew) {
        if (draft.prompt !== null && hasLlm) await compileFlow(flowId).catch(() => undefined);
        navigate(`/flows/${flowId}/edit`, { replace: true });
        return;
      }
      if (current) {
        qc.setQueryData(flowQueryKey(flowId), current);
        const next = draftFromFlow(current);
        lastStamp.current = stampOf(current);
        setSaved(next);
        setDraft(next);
      }
      setShowProblems(false);
      setNotice("Saved.");
    } catch (err) {
      const message = errorText(err);
      void qc.invalidateQueries({ queryKey: EMAIL_TEMPLATE_ROWS_KEY });
      if (isNew && flowId) {
        navigate(`/flows/${flowId}/edit`, { replace: true, state: { saveError: `The flow was created, but not everything saved: ${message}` } });
        return;
      }
      if (flowId) void qc.invalidateQueries({ queryKey: flowQueryKey(flowId) });
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  // Cmd/Ctrl+S saves.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (!archived) void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [archived]);

  async function transition(status: "active" | "paused") {
    setError(null);
    try {
      await statusMutation.mutateAsync(status);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function archive() {
    setError(null);
    try {
      await archiveMutation.mutateAsync();
      navigate("/flows");
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function compile() {
    setCompileError(null);
    try {
      await compileMutation.mutateAsync();
    } catch (err) {
      setCompileError(errorText(err));
    }
  }

  function applyJson() {
    if (json === null) return;
    try {
      const parsed = JSON.parse(json) as { steps?: unknown; exit_conditions?: unknown };
      if (!Array.isArray(parsed.steps)) throw new Error("the JSON needs a steps list");
      const exits = Array.isArray(parsed.exit_conditions) ? (parsed.exit_conditions as Json[]) : [];
      update({ steps: sortSteps(parsed.steps as Json[]), exits });
      setJson(null);
      setSelected("trigger");
    } catch (err) {
      setError(err instanceof Error ? `JSON: ${err.message}` : "The JSON could not be read.");
    }
  }

  const canActivate = !!flow && flow.compile_status === "ready" && flow.compiled_plan !== null && !dirty;
  const transitionBusy = statusMutation.isPending || archiveMutation.isPending || saving;
  const promptDirty = flow ? draft.prompt !== saved.prompt : false;

  const env: EditorEnv = {
    flowId: flow?.id,
    canDraftWithAi: !!flow && !changes.plan,
    hasLlm,
    links,
    dataSources: ctx.data?.data_sources ?? [],
    kbCategories,
    sample,
    disabled,
  };

  let panel: React.ReactNode = null;
  if (selected === "trigger") {
    panel = (
      <TriggerPanel
        trigger={draft.trigger}
        onChange={(t: TriggerDraft) => update({ trigger: t })}
        eventNames={eventNames.data ?? []}
        dateTraits={ctx.data?.date_traits ?? []}
        disabled={disabled}
        isNew={isNew}
        problems={problemTexts("trigger")}
      />
    );
  } else if (selected === "exits") {
    panel = <ExitsPanel exits={draft.exits} onChange={(exits) => update({ exits })} eventNames={eventNames.data ?? []} disabled={disabled} />;
  } else if (selected === "prompt" && draft.prompt !== null) {
    panel = (
      <PromptPanel
        prompt={draft.prompt}
        onChange={(v) => update({ prompt: v })}
        flow={flow}
        promptDirty={promptDirty}
        locked={flow?.status === "active"}
        disabled={disabled}
        hasLlm={hasLlm}
        compiling={compileMutation.isPending || flow?.compile_status === "pending"}
        compileError={compileError}
        onCompile={() => void compile()}
      />
    );
  } else if (typeof selected === "number" && draft.steps[selected]) {
    const i = selected;
    const step = draft.steps[i]!;
    const ref = stepMode(step) === "fixed" ? String(step.template_ref) : null;
    const usedBy = ref ? (ctx.data?.templates.find((t) => t.slug === ref)?.used_by_flows ?? []) : [];
    panel = (
      <StepPanel
        key={`${i}-${String(step.order)}`}
        index={i}
        count={draft.steps.length}
        step={step}
        previousDelayLabel={i > 0 ? describeDelay(draft.steps[i - 1]?.delay) : ""}
        isSchedule={draft.trigger.type === "date_schedule"}
        copy={ref ? copyOf(ref) : undefined}
        sharedWith={usedBy.filter((f) => f !== flow?.id).length}
        env={env}
        problems={problemTexts(i)}
        onStep={(patch) => updateStep(i, patch)}
        onCopy={(c) => {
          if (ref) setDraft((d) => ({ ...d, copies: { ...d.copies, [ref]: c } }));
          setNotice(null);
        }}
        onMode={(m) => setMode(i, m)}
        onMove={(dir) => {
          update({ steps: moveStep(draft.steps, i, dir) });
          setSelected(i + dir);
        }}
        onRemove={() => {
          update({ steps: draft.steps.filter((_, j) => j !== i) });
          setSelected(draft.steps.length > 1 ? Math.max(0, i - 1) : "trigger");
        }}
      />
    );
  }

  const nameProblem = showProblems && problems.some((p) => p.where === "name");

  return (
    <div className="mx-auto max-w-7xl">
      {/* Header */}
      <div>
        <Link to="/flows" className="text-[15px] text-muted-foreground transition-colors hover:text-foreground">&larr; Flows</Link>
        <div className="mt-2 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1 basis-80">
                <FlowNameInput value={draft.name} onChange={(v) => update({ name: v })} disabled={disabled} />
              </div>
              {flow && <Badge variant={statusVariant(flow.status)}>{flow.status}</Badge>}
              {isNew && <Badge variant="neutral">not saved yet</Badge>}
              {flow?.slug && !archived && configNoticeDismissed && (
                <Link
                  to="/settings/config"
                  title={`Managed in config as code (slug ${flow.slug}). The next claros apply of a document that lists this flow replaces edits made here.`}
                >
                  <Badge variant="muted">config as code</Badge>
                </Link>
              )}
            </div>
            {nameProblem && <p className="mt-1 text-[14px] text-danger" role="alert">Give the flow a name.</p>}
            <p className="mt-1.5 max-w-3xl text-[16px] leading-relaxed text-muted-foreground">{summarizeFlow(draft)}</p>
          </div>
          {flow && !archived && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 lg:pt-1.5">
              {confirmArchive ? (
                <>
                  <span className="text-[15px] text-muted-foreground">Archive for good? It cannot be undone.</span>
                  <Button size="sm" variant="destructive" disabled={transitionBusy} onClick={() => void archive()}>Archive</Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmArchive(false)}>Cancel</Button>
                </>
              ) : (
                <>
                  {(flow.status === "draft" || flow.status === "paused") && (
                    <Button
                      size="sm"
                      disabled={transitionBusy || !canActivate}
                      title={dirty ? "Save your changes first." : canActivate ? undefined : "Add at least one email and save before activating."}
                      onClick={() => void transition("active")}
                    >
                      <Play size={16} strokeWidth={1.5} aria-hidden="true" />
                      {flow.status === "paused" ? "Resume" : "Activate"}
                    </Button>
                  )}
                  {flow.status === "active" && (
                    <Button size="sm" variant="outline" disabled={transitionBusy} onClick={() => void transition("paused")}>
                      <Pause size={16} strokeWidth={1.5} aria-hidden="true" />
                      Pause
                    </Button>
                  )}
                  <MoreMenu
                    items={[
                      { label: "Edit the emails as JSON", onClick: () => setJson(JSON.stringify(planBody(draft), null, 2)) },
                      { label: "Copy flow ID", onClick: () => void navigator.clipboard?.writeText(flow.id).catch(() => undefined) },
                      { label: "Archive flow", onClick: () => setConfirmArchive(true), danger: true },
                    ]}
                  />
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Banners */}
      <div className="mt-5 space-y-3 empty:hidden">
        {flow?.slug && !archived && !configNoticeDismissed && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-warning bg-warning-soft px-4 py-2.5 text-[15px] text-foreground" role="note">
            <span className="min-w-0 flex-1 basis-96">
              <span className="font-semibold">Managed in config as code</span> (slug <code className="font-mono text-[14px]">{flow.slug}</code>). The next{" "}
              <code className="font-mono text-[14px]">claros apply</code> of a document that lists this flow replaces edits made here. Change the document, or export it again after editing.
            </span>
            <Link to="/settings/config" className="shrink-0 text-[15px] font-medium text-accent-text hover:underline">Config as code</Link>
            <button
              type="button"
              aria-label="Dismiss"
              title="Dismiss. A config as code badge stays next to the flow status."
              onClick={dismissConfigNotice}
              className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              <X size={16} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </div>
        )}
        {archived && (
          <p className="rounded-lg border border-border bg-secondary px-4 py-2.5 text-[15px] text-muted-foreground" role="note">
            This flow is archived. Archived is final; nothing here can be changed.
          </p>
        )}
        {flow?.status === "active" && dirty && (
          <p className="rounded-lg border border-border bg-sunken px-4 py-2.5 text-[15px] text-muted-foreground" role="note">
            The flow keeps running on the saved version until you save.
          </p>
        )}
      </div>

      {/* Tabs */}
      <div role="tablist" className="mt-5 flex gap-1 border-b border-border">
        {([["emails", "Emails"], ["settings", "Delivery settings"]] as const).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-[16px] font-medium transition-colors ${tab === value ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "settings" ? (
        <div className="mt-6">
          <DeliverySettings draft={draft} onChange={(patch) => update(patch)} topics={topics.data?.topics ?? []} templates={layouts.data ?? null} disabled={disabled} flow={flow} />
        </div>
      ) : json !== null ? (
        <div className="mt-6 rounded-xl border border-border bg-card shadow-card p-5">
          <h2 className="text-[18px] font-semibold text-foreground">The emails as JSON</h2>
          <p className="mt-0.5 text-[15px] text-muted-foreground">
            The steps and exit conditions in the config document shape (see the Flows guide). Applying puts them in the draft; saving stores them.
          </p>
          <Textarea aria-label="Steps as JSON" className="mt-3 min-h-[28rem] font-mono text-[13px]" value={json} onChange={(e) => setJson(e.target.value)} />
          <div className="mt-3 flex gap-2">
            <Button type="button" onClick={applyJson}>Apply to draft</Button>
            <Button type="button" variant="ghost" onClick={() => setJson(null)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:gap-8">
          <FlowTimeline
            draft={draft}
            selected={selected}
            onSelect={select}
            copyOf={copyOf}
            sample={sample.values}
            problemsAt={problemsAt}
            onAdd={addStep}
            canAddAi={hasLlm}
            disabled={disabled}
          />
          <div ref={panelRef} className="scroll-mt-6 rounded-xl border border-border bg-card shadow-card p-5 sm:p-6">
            {panel ?? <p className="text-[15px] text-muted-foreground">Select a part of the flow on the left to edit it.</p>}
          </div>
        </div>
      )}

      {/* Save bar */}
      {!archived && (dirty || error || notice) && (
        <div className="sticky bottom-0 z-20 mt-8 border-t border-border bg-background/95 py-3 backdrop-blur">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1 basis-64 text-[15px]" role="status">
              {error ? (
                <span className="text-danger">{error}</span>
              ) : notice ? (
                <span className="text-muted-foreground">{notice}</span>
              ) : isNew ? (
                <span className="text-muted-foreground">Not saved yet. Creating saves the flow as a draft; nothing sends until you activate it.</span>
              ) : (
                <span className="text-muted-foreground">Unsaved changes.</span>
              )}
            </div>
            {dirty && (
              <>
                <Button type="button" variant="ghost" disabled={saving} onClick={discard}>
                  {isNew ? "Cancel" : "Discard"}
                </Button>
                <Button type="button" disabled={saving} onClick={() => void save()}>
                  {saving ? "Saving..." : isNew ? "Create flow" : "Save changes"}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function EditorSkeleton() {
  return (
    <div className="mx-auto max-w-7xl">
      <Skeleton className="h-4 w-16" />
      <Skeleton className="mt-4 h-8 w-72" />
      <Skeleton className="mt-3 h-4 w-[32rem] max-w-full" />
      <div className="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-[360px_1fr]">
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    </div>
  );
}

/** The config-as-code notice is shown until dismissed once (per browser), then a badge stands in for it. */
const CONFIG_NOTICE_KEY = "claros.flowEditor.configNoticeDismissed";

function readConfigNoticeDismissed(): boolean {
  try {
    return localStorage.getItem(CONFIG_NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

export default function FlowEditorPage() {
  const { id } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const flowQuery = useFlowWithPolling(id ?? "");
  const templatesQuery = useEmailTemplateRows();
  const ctx = useFlowEditorContext();
  const [start, setStart] = useState<{ draft: EditorDraft; select: Selection } | null>(() => {
    const prefill = id ? null : prefillFromSearch(searchParams);
    return prefill ? { draft: prefill, select: "trigger" } : null;
  });
  const saveError = (location.state as { saveError?: string } | null)?.saveError ?? null;

  if (!id) {
    if (!start) {
      return <StartScreen hasLlm={ctx.data?.has_llm ?? false} dateTraits={ctx.data?.date_traits ?? []} onPick={(draft, select) => setStart({ draft, select })} />;
    }
    return <FlowWorkspace initialDraft={start.draft} initialSelection={start.select} templates={templatesQuery.data ?? []} />;
  }

  if (flowQuery.isError) {
    return (
      <div className="mx-auto max-w-7xl rounded-md border border-danger bg-danger-soft px-4 py-3" role="alert">
        <p className="text-[16px] text-foreground">Failed to load flow: {flowQuery.error instanceof Error ? flowQuery.error.message : "unknown error"}</p>
      </div>
    );
  }
  if (!flowQuery.data || templatesQuery.isLoading) return <EditorSkeleton />;

  const flow = flowQuery.data;
  const initial = draftFromFlow(flow);
  // ?template=<slug> (linked from Sent Mail) opens the email that uses it.
  const templateSlug = searchParams.get("template");
  const linked = templateSlug ? initial.steps.findIndex((s) => s.template_ref === templateSlug) : -1;
  return (
    <FlowWorkspace
      key={flow.id}
      flow={flow}
      initialDraft={initial}
      initialSelection={linked >= 0 ? linked : initial.steps.length > 0 ? 0 : initial.prompt !== null ? "prompt" : "trigger"}
      templates={templatesQuery.data ?? []}
      initialError={saveError}
    />
  );
}
