/**
 * Flow editor page.
 *
 * Handles both create (/flows/new) and edit (/flows/:id/edit) in a single
 * component. The mode is determined by whether an :id param is present.
 *
 * Two distinct editing experiences:
 *   1. Prompt-defined flows (source: "manual" | "brain_suggested") -
 *      the prompt is the primary surface. The user writes what the flow
 *      should do, Claros compiles it into a plan, and the brain drafts
 *      each email per contact at send time.
 *   2. Library flows (source: "library") - pre-built flows with fixed
 *      email copy in templates. No prompt, no LLM needed. The editor
 *      shows the plan and lets the user edit template content inline.
 *
 * Template editing lives here as a detail of a step, not as a separate
 * destination. Click a template_ref in the plan to edit its content.
 *
 * Layout:
 *   - New flow: single column, progressive disclosure. Step 1 is the
 *     trigger (cards + inline config), step 2 is who writes the emails,
 *     step 3 is the writing surface (prompt or step writer). The name is
 *     the page title itself, edited inline. There is no sidebar.
 *   - Edit flow: the trigger renders as a summary with an "Edit trigger"
 *     action (PATCH trigger_type + trigger_config). The right rail carries
 *     the flow settings (class, priority, re-entry) and meta.
 *   - Plan editor (edit mode): every step field written out (choose steps,
 *     context, kb_select, sender fields, links, conditions with all / any /
 *     not, expiry) and the plan exits, saved with PUT /v1/flows/:id/steps.
 *
 * Behaviour preserved from the previous implementation:
 *   - lifecycle_transition takes from + to over the seven lifecycle states
 *   - event takes an event name string, sent as { event: "..." }
 *   - manual flows are enrolled through POST /v1/flows/:id/enroll
 *   - steps is always sent as [] on create
 *   - 400 issues map to their fields; a 422 shows the server's string
 *     verbatim; a failed save never renders as success
 *
 * Compilation: POST /v1/flows/:id/compile returns 202, the flow query polls
 * every 3 s while compile_status is pending. compile_error renders verbatim.
 * Saving a changed prompt clears the plan; the user is warned before saving,
 * and only when a plan actually exists.
 *
 * Status lifecycle (PATCH status / DELETE):
 *   draft|paused -> active requires compile_status ready + a plan (the API
 *   enforces; the button is disabled with a hint, not silently rejected).
 *   active -> paused. Anything not archived -> archived, behind an inline
 *   confirmation, because archived is terminal. 409 (concurrent transition)
 *   and 422 surface as banners with the server's message.
 */
import React, { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, useSearchParams, Link } from "react-router-dom";
import { Pause, Play } from "lucide-react";
import {
  useFlowWithPolling,
  useCreateFlow,
  useUpdateFlow,
  useCompileFlow,
  useFlowStatus,
  useArchiveFlow,
  useSaveFlowPlan,
  useDraftFlowStep,
  useEventNames,
  useSaveFlowSteps,
} from "../flows.js";
import type { Flow, FlowApiError, FlowFieldError } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Badge, type BadgeVariant } from "../components/ui/badge.js";
import { Input } from "../components/ui/input.js";
import { Select } from "../components/ui/select.js";
import { Textarea } from "../components/ui/textarea.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { TemplateEditorBySlug } from "../components/template-editor.js";
import { StepWriter, buildPlanBody, type StepData } from "../components/step-writer.js";
import { useLlm } from "../settings.js";
import { FlowTopicPicker } from "../components/flow-topic-picker.js";
import { TriggerEditor } from "../components/trigger-editor.js";
import { PlanEditor, planFromFlow } from "../components/plan-editor.js";
import {
  FLOW_CLASS_OPTIONS,
  cleanTriggerConfig,
  summarizeCondition,
  summarizeTrigger,
  triggerProblems,
  type TriggerDraft,
  type TriggerType,
} from "../lib/flow-model.js";

// ---------------------------------------------------------------------------
// Constants derived from the engine (packages/core/src/lifecycle/states.ts)
// ---------------------------------------------------------------------------

const LIFECYCLE_STATES: ReadonlyArray<string> = [
  "signed_up",
  "activated",
  "engaged",
  "at_risk",
  "dormant",
  "churned",
  "resurrected",
];

// Retention-grid bucket labels (mirror of packages/core retention-grid.ts).
const TENURE_BUCKET_OPTIONS = [
  { value: "new", label: "New (< 30 days)" },
  { value: "growing", label: "Growing (30-89 days)" },
  { value: "established", label: "Established (90-179 days)" },
  { value: "loyal", label: "Loyal (180+ days)" },
] as const;

const RECENCY_BUCKET_OPTIONS = [
  { value: "active", label: "Active (inside the natural rhythm)" },
  { value: "cooling", label: "Cooling (1-2x the rhythm quiet)" },
  { value: "idle", label: "Idle (2-4x the rhythm quiet)" },
  { value: "dormant", label: "Dormant (4x+ the rhythm quiet)" },
] as const;

// ---------------------------------------------------------------------------
// Shared small components
// ---------------------------------------------------------------------------

function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <p className="mt-1 text-[13px] text-danger" role="alert">
      {message}
    </p>
  );
}

function Label({
  htmlFor,
  children,
  required,
}: {
  htmlFor: string;
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1.5 block text-[14px] font-medium text-foreground"
    >
      {children}
      {required && <span className="ml-0.5 text-danger" aria-hidden="true">*</span>}
    </label>
  );
}

function statusVariant(status: Flow["status"]): BadgeVariant {
  switch (status) {
    case "active": return "success";
    case "draft": return "neutral";
    case "paused": return "warning";
    case "archived": return "muted";
  }
}

function compileVariant(cs: Flow["compile_status"]): BadgeVariant {
  switch (cs) {
    case null: return "muted";
    case "pending": return "warning";
    case "ready": return "success";
    case "failed": return "danger";
  }
}

function compileLabel(cs: Flow["compile_status"]): string {
  switch (cs) {
    case null: return "not compiled";
    case "pending": return "compiling";
    case "ready": return "ready";
    case "failed": return "failed";
  }
}

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

// ---------------------------------------------------------------------------
// Page-level building blocks
// ---------------------------------------------------------------------------

/** Numbered section heading used by the new-flow progressive disclosure. */
function SectionHeading({
  step,
  title,
  description,
}: {
  step: number;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-full border border-border-strong bg-background font-mono text-[12px] text-muted-foreground"
      >
        {step}
      </span>
      <div className="min-w-0">
        <p className="text-[15px] font-semibold text-foreground">{title}</p>
        {description && (
          <p className="mt-1 text-[14px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The flow name as the page title: a borderless input styled like the h1.
 * The hover/focus background is the only affordance that it is editable.
 */
function FlowNameInput({
  value,
  onChange,
  disabled,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  error?: string;
}) {
  return (
    <div className="min-w-0 flex-1">
      <input
        id="flow-name"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Untitled flow"
        disabled={disabled}
        aria-label="Flow name"
        className="-ml-2 w-full min-w-0 rounded-md bg-transparent px-2 py-1 font-display text-[28px] font-bold leading-[34px] tracking-[-0.02em] text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 hover:bg-sunken focus:bg-sunken disabled:hover:bg-transparent"
      />
      <FieldError message={error} />
    </div>
  );
}

/** Read-only trigger summary for edit mode. The trigger is immutable. */
function TriggerSummary({ flow, onEdit }: { flow: Flow; onEdit?: () => void }) {
  return (
    <div className="rounded-lg border border-border bg-card px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          Starts when
        </p>
        {onEdit && (
          <Button type="button" size="sm" variant="ghost" className="h-7" onClick={onEdit}>
            Edit trigger
          </Button>
        )}
      </div>
      <p className="mt-1.5 text-[15px] text-foreground">
        {summarizeTrigger(flow.trigger_type, (flow.trigger_config ?? {}) as Record<string, unknown>)}
      </p>
    </div>
  );
}

/** Edit an existing flow's trigger (PATCH trigger_type + trigger_config). */
function TriggerEditCard({
  flow,
  suggestions,
  onDone,
}: {
  flow: Flow;
  suggestions: string[];
  onDone: () => void;
}) {
  const update = useUpdateFlow(flow.id);
  const [draft, setDraft] = useState<TriggerDraft>({
    type: flow.trigger_type as TriggerType,
    config: { ...((flow.trigger_config ?? {}) as Record<string, unknown>) },
  });
  const [error, setError] = useState<string | null>(null);
  const problems = triggerProblems(draft);

  async function save() {
    setError(null);
    try {
      await update.mutateAsync({ trigger_type: draft.type, trigger_config: cleanTriggerConfig(draft) });
      onDone();
    } catch (err) {
      setError(toMessage(err));
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <p className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        Edit trigger
      </p>
      <p className="mb-4 text-[13px] text-muted-foreground">
        Contacts already in the flow stay; the new trigger decides who enters from now on.
      </p>
      <TriggerEditor draft={draft} onChange={setDraft} disabled={update.isPending} eventSuggestions={suggestions} />
      {problems.length > 0 && (
        <ul className="mt-3 list-disc pl-5 text-[13px] text-muted-foreground">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
      {error && <p className="mt-3 text-[14px] text-danger" role="alert">{error}</p>}
      <div className="mt-4 flex items-center gap-2">
        <Button type="button" size="sm" disabled={update.isPending || problems.length > 0} onClick={() => void save()}>
          {update.isPending ? "Saving..." : "Save trigger"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Flow class, priority and re-entry (right rail, edit mode). */
function FlowSettingsCard({ flow, disabled }: { flow: Flow; disabled?: boolean }) {
  const update = useUpdateFlow(flow.id);
  const [priority, setPriority] = useState(String(flow.priority ?? 0));
  const [cooldown, setCooldown] = useState(String(flow.reentry_cooldown_days ?? 30));
  const [error, setError] = useState<string | null>(null);
  const busy = update.isPending || disabled;

  async function patch(input: Parameters<typeof update.mutateAsync>[0]) {
    setError(null);
    try {
      await update.mutateAsync(input);
    } catch (err) {
      setError(toMessage(err));
    }
  }

  const classHint = FLOW_CLASS_OPTIONS.find((o) => o.value === flow.flow_class)?.hint;
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <p className="mb-4 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        Flow settings
      </p>
      <div className="space-y-4 text-[14px]">
        <div>
          <label htmlFor="flow-class" className="mb-1 block text-muted-foreground">Class</label>
          <Select id="flow-class" value={flow.flow_class} disabled={busy} onChange={(e) => void patch({ flow_class: e.target.value as Flow["flow_class"] })}>
            {FLOW_CLASS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
          {classHint && <p className="mt-1 text-[12px] text-muted-foreground">{classHint}</p>}
        </div>
        <div>
          <label htmlFor="flow-priority" className="mb-1 block text-muted-foreground">Priority</label>
          <Input
            id="flow-priority"
            type="number"
            value={priority}
            disabled={busy}
            onChange={(e) => setPriority(e.target.value)}
            onBlur={() => {
              const n = Number(priority);
              if (Number.isInteger(n) && n !== flow.priority) void patch({ priority: n });
            }}
          />
        </div>
        <div>
          <label htmlFor="flow-reentry" className="mb-1 block text-muted-foreground">Re-entry</label>
          <Select id="flow-reentry" value={flow.reentry_policy} disabled={busy} onChange={(e) => void patch({ reentry_policy: e.target.value as Flow["reentry_policy"] })}>
            <option value="once">once</option>
            <option value="cooldown">after a cooldown</option>
            <option value="every_time">every time</option>
          </Select>
        </div>
        {flow.reentry_policy === "cooldown" && (
          <div>
            <label htmlFor="flow-cooldown" className="mb-1 block text-muted-foreground">Cooldown (days)</label>
            <Input
              id="flow-cooldown"
              type="number"
              min={1}
              value={cooldown}
              disabled={busy}
              onChange={(e) => setCooldown(e.target.value)}
              onBlur={() => {
                const n = Number(cooldown);
                if (Number.isInteger(n) && n >= 1 && n !== flow.reentry_cooldown_days) void patch({ reentry_cooldown_days: n });
              }}
            />
          </div>
        )}
        {error && <p className="text-[13px] text-danger" role="alert">{error}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface FormState {
  name: string;
  trigger: TriggerDraft;
  prompt_source: string;
  approval_mode: Flow["approval_mode"];
  content_mode: Flow["content_mode"];
  steps_data: StepData[];
}

function defaultFormState(): FormState {
  return {
    name: "",
    trigger: { type: "lifecycle_transition", config: {} },
    prompt_source: "",
    approval_mode: "require",
    content_mode: "ai_drafted",
    steps_data: [],
  };
}

function formStateFromFlow(flow: Flow): FormState {
  return {
    name: flow.name,
    trigger: { type: flow.trigger_type as TriggerType, config: { ...((flow.trigger_config ?? {}) as Record<string, unknown>) } },
    prompt_source: flow.prompt_source ?? "",
    approval_mode: flow.approval_mode,
    content_mode: (flow.content_mode as Flow["content_mode"]) ?? "ai_drafted",
    steps_data: [],
  };
}

function buildTriggerConfig(state: FormState): Record<string, unknown> {
  return cleanTriggerConfig(state.trigger);
}

// ---------------------------------------------------------------------------
// Field error helpers
// ---------------------------------------------------------------------------

type FieldErrors = Partial<Record<string, string>>;

function extractFieldErrors(issues: FlowFieldError[]): FieldErrors {
  const map: FieldErrors = {};
  for (const issue of issues) {
    const key = issue.path === "" ? "_form" : issue.path;
    map[key] = issue.message;
  }
  return map;
}

function toMessage(err: unknown): string {
  if (err !== null && typeof err === "object" && "kind" in err) {
    const apiErr = err as FlowApiError;
    if (apiErr.kind === "validation") {
      return apiErr.issues.map((i) => i.message).join("; ");
    }
    return apiErr.message;
  }
  return err instanceof Error ? err.message : "An unexpected error occurred.";
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function EditorSkeleton() {
  return (
    <div className="mx-auto max-w-6xl">
      <Skeleton className="h-4 w-16" />
      <Skeleton className="mt-4 h-8 w-64" />
      <div className="mt-8 flex gap-8">
        <div className="min-w-0 flex-1 space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-9 w-40" />
        </div>
        <div className="hidden w-72 shrink-0 lg:block">
          <Skeleton className="h-28 w-full" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compiled plan renderer
// ---------------------------------------------------------------------------

type UnknownRecord = Record<string, unknown>;

/**
 * Humanize a delay string. "0m" -> "right away", "2h" -> "after 2 hours".
 * Anything that does not match the shape renders verbatim in mono.
 */
function renderDelay(delay: string): React.ReactNode {
  const m = /^(\d+)([mhd])$/.exec(delay);
  if (!m) return <code className="font-mono text-[13px]">{delay}</code>;
  const n = Number(m[1]);
  if (n === 0) return "right away";
  const unit = m[2] === "m" ? "minute" : m[2] === "h" ? "hour" : "day";
  return `after ${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** A condition (or a list: all of them) as a readable clause. */
function renderConditionClause(cond: unknown): React.ReactNode {
  return <span>{summarizeCondition(cond)}</span>;
}

/** A plan-level exit condition as a readable clause. */
function renderPlanExitCondition(cond: unknown): React.ReactNode {
  return <span>{summarizeCondition(cond)}</span>;
}

/** Sender, links, expiry, context, KB and choose details of a step. */
function StepDetails({ step }: { step: UnknownRecord }) {
  const parts: string[] = [];
  if (typeof step.from_name === "string") parts.push(`from ${step.from_name}`);
  if (typeof step.reply_to === "string") parts.push(`reply-to ${step.reply_to}`);
  if (typeof step.eyebrow === "string") parts.push(`eyebrow "${step.eyebrow}"`);
  if (typeof step.preheader === "string") parts.push(`preheader "${step.preheader}"`);
  if (Array.isArray(step.allowed_links)) parts.push(`links ${(step.allowed_links as string[]).join(", ")}`);
  if (step.single_cta === true) parts.push("one call to action");
  if (typeof step.expires_after === "string") parts.push(`expires after ${step.expires_after}`);
  if (Array.isArray(step.context)) parts.push(`context ${(step.context as UnknownRecord[]).map((c) => String(c.source ?? "")).join(", ")}`);
  const kb = step.kb_select as UnknownRecord | undefined;
  if (kb && typeof kb === "object") parts.push(`knowledge base ${String(kb.category ?? "")}`);
  const candidates = Array.isArray(step.candidates) ? (step.candidates as UnknownRecord[]) : [];
  if (parts.length === 0 && candidates.length === 0) return null;
  return (
    <>
      {parts.length > 0 && <p className="text-[13px] text-muted-foreground">{parts.join(" · ")}</p>}
      {candidates.length > 0 && (
        <p className="text-[13px] text-muted-foreground">
          the AI chooses {step.allow_none === false ? "one of" : "one of (or none)"}:{" "}
          {candidates.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 && ", "}
              <code className="font-mono text-[13px]">{String(c.action_type ?? "")}</code>
              {c.when !== undefined ? ` if ${summarizeCondition(c.when)}` : ""}
            </React.Fragment>
          ))}
        </p>
      )}
    </>
  );
}

function CompiledPlanPreview({
  plan,
  onEditTemplate,
}: {
  plan: UnknownRecord;
  onEditTemplate?: (slug: string) => void;
}) {
  const trigger = plan.trigger as UnknownRecord | undefined;
  const steps = Array.isArray(plan.steps) ? (plan.steps as UnknownRecord[]) : [];
  const exitConditions = Array.isArray(plan.exit_conditions)
    ? (plan.exit_conditions as unknown[])
    : [];

  return (
    <div className="space-y-6">
      {/* Trigger */}
      {trigger && (
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            Fires when
          </p>
          <p className="mt-1.5 text-[14px] text-foreground">
            <code className="font-mono text-[13px]">{String(trigger.type ?? "")}</code>
            {trigger.condition !== null &&
              trigger.condition !== undefined &&
              typeof trigger.condition === "object" && (
                <span className="text-muted-foreground">
                  {" "}matching{" "}
                  <code className="font-mono text-[13px]">
                    {JSON.stringify(trigger.condition)}
                  </code>
                </span>
              )}
          </p>
        </div>
      )}

      {/* Steps */}
      {steps.length > 0 && (
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            Then, in order
          </p>
          <ol className="mt-2 list-none space-y-0">
            {steps.map((step, idx) => (
              <li key={idx} className="relative flex gap-4 pb-5 last:pb-0">
                {/* Connector line + order node */}
                {idx < steps.length - 1 && (
                  <span
                    aria-hidden="true"
                    className="absolute left-[11px] top-6 h-full w-px bg-border"
                  />
                )}
                <span
                  aria-hidden="true"
                  className="z-10 mt-0.5 flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-full border border-border-strong bg-background font-mono text-[12px] text-muted-foreground"
                >
                  {typeof step.order === "number" ? step.order : idx + 1}
                </span>
                <div className="min-w-0 flex-1 space-y-1 pt-0.5">
                  <p className="text-[14px] text-foreground">
                    <code className="font-mono text-[13px]">{String(step.action_type ?? "")}</code>
                    {typeof step.delay === "string" && (
                      <span className="text-muted-foreground"> {renderDelay(step.delay)}</span>
                    )}
                    {typeof step.window_policy === "string" && (
                      <span className="text-muted-foreground">
                        {step.window_policy === "immediate"
                          ? ", outside the send window"
                          : ", within the send window"}
                      </span>
                    )}
                  </p>
                  {(typeof step.template_ref === "string" || typeof step.kb_ref === "string") && (
                    <p className="text-[13px] text-muted-foreground">
                      {typeof step.template_ref === "string" && (
                        onEditTemplate ? (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[13px] text-accent-text transition-colors hover:bg-sunken"
                            onClick={() => onEditTemplate(step.template_ref as string)}
                          >
                            template <code className="font-mono">{step.template_ref}</code>
                            <span className="text-[11px] text-muted-foreground">(edit)</span>
                          </button>
                        ) : (
                          <>template <code className="font-mono text-[13px]">{step.template_ref}</code></>
                        )
                      )}
                      {typeof step.template_ref === "string" && typeof step.kb_ref === "string" && " · "}
                      {typeof step.kb_ref === "string" && (
                        <>kb <code className="font-mono text-[13px]">{step.kb_ref}</code></>
                      )}
                    </p>
                  )}
                  {typeof step.brain_instruction === "string" && (
                    <p className="text-[13px] italic text-muted-foreground">
                      {step.brain_instruction}
                    </p>
                  )}
                  <StepDetails step={step} />
                  {step.condition !== undefined && step.condition !== null && (
                    <p className="text-[13px] text-muted-foreground">
                      only if {renderConditionClause(step.condition)}
                    </p>
                  )}
                  {step.exit_condition !== undefined && step.exit_condition !== null && (
                    <p className="text-[13px] text-muted-foreground">
                      exit the flow if {renderConditionClause(step.exit_condition)}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Plan-level exit conditions */}
      {exitConditions.length > 0 && (
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            The flow ends early if
          </p>
          <ul className="mt-1.5 list-none space-y-1">
            {exitConditions.map((ec, idx) => (
              <li key={idx} className="text-[14px] text-muted-foreground">
                {renderPlanExitCondition(ec)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status actions (header cluster, edit mode)
// ---------------------------------------------------------------------------

interface StatusActionsProps {
  flow: Flow;
  busy: boolean;
  onTransition: (status: "active" | "paused") => void;
  onArchive: () => void;
}

function StatusActions({ flow, busy, onTransition, onArchive }: StatusActionsProps) {
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  if (flow.status === "archived") {
    return null;
  }

  if (confirmingArchive) {
    return (
      <div className="flex items-center gap-3">
        <span className="text-[14px] text-muted-foreground">
          Archive permanently? There is no way back.
        </span>
        <Button
          variant="destructive"
          size="sm"
          disabled={busy}
          onClick={onArchive}
        >
          Archive
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => setConfirmingArchive(false)}
        >
          Cancel
        </Button>
      </div>
    );
  }

  const canActivate = flow.compile_status === "ready" && flow.compiled_plan !== null;

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => setConfirmingArchive(true)}
      >
        Archive
      </Button>
      {(flow.status === "draft" || flow.status === "paused") && (
        <Button
          size="sm"
          disabled={busy || !canActivate}
          title={
            canActivate
              ? undefined
              : "Compile the flow and wait for compile status 'ready' before activating."
          }
          onClick={() => onTransition("active")}
        >
          <Play size={16} strokeWidth={1.5} aria-hidden="true" />
          {flow.status === "paused" ? "Resume" : "Activate"}
        </Button>
      )}
      {flow.status === "active" && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onTransition("paused")}
        >
          <Pause size={16} strokeWidth={1.5} aria-hidden="true" />
          Pause
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function FlowEditorPage() {
  const { id } = useParams<{ id?: string }>();
  const isNew = !id;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const flowQuery = useFlowWithPolling(id ?? "");
  const createMutation = useCreateFlow();
  const updateMutation = useUpdateFlow(id ?? "");
  const compileMutation = useCompileFlow(id ?? "");
  const statusMutation = useFlowStatus(id ?? "");
  const archiveMutation = useArchiveFlow(id ?? "");
  const savePlanMutation = useSaveFlowPlan(id ?? "");
  const saveStepsMutation = useSaveFlowSteps(id ?? "");
  const llmQuery = useLlm();
  const eventNamesQuery = useEventNames();

  const [form, setForm] = useState<FormState>(defaultFormState);
  const [contentModeSelected, setContentModeSelected] = useState(false);
  const [promptDirty, setPromptDirty] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [initialised, setInitialised] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<string | null>(null);
  const [editingTrigger, setEditingTrigger] = useState(false);
  const [planEditorOpen, setPlanEditorOpen] = useState(false);

  // New-flow progressive disclosure: section refs for scroll-into-view.
  const step2Ref = useRef<HTMLElement>(null);
  const step3Ref = useRef<HTMLElement>(null);
  const prevTriggerCompleteRef = useRef<boolean | null>(null);

  // Populate form when editing an existing flow
  useEffect(() => {
    if (!isNew && flowQuery.data && !initialised) {
      setForm(formStateFromFlow(flowQuery.data));
      setInitialised(true);
    }
  }, [isNew, flowQuery.data, initialised]);

  // Initialise immediately for new flow. Two prefill params, both from the
  // retention grid: ?segment=tenure:recency (primary, targets the cell's
  // current population) and ?transition=from:to with optional &name=
  // (secondary, catches future transitions only).
  useEffect(() => {
    if (isNew && !initialised) {
      const segment = searchParams.get("segment");
      const transition = searchParams.get("transition");
      if (segment) {
        const [tenure, recency] = segment.split(":");
        const tenureOpt = TENURE_BUCKET_OPTIONS.find((o) => o.value === tenure);
        const recencyOpt = RECENCY_BUCKET_OPTIONS.find((o) => o.value === recency);
        if (tenureOpt && recencyOpt) {
          setForm({
            ...defaultFormState(),
            name: `${tenureOpt.label.split(" (")[0]} · ${recencyOpt.label.split(" (")[0]}`,
            trigger: { type: "segment", config: { tenure_bucket: tenureOpt.value, recency_bucket: recencyOpt.value } },
          });
        }
      } else if (transition) {
        const [from, to] = transition.split(":");
        if (
          LIFECYCLE_STATES.includes(from ?? "") &&
          LIFECYCLE_STATES.includes(to ?? "")
        ) {
          setForm({
            ...defaultFormState(),
            name: searchParams.get("name") ?? "",
            trigger: { type: "lifecycle_transition", config: { from: from!, to: to! } },
          });
        }
      }
      setInitialised(true);
    }
  }, [isNew, initialised, searchParams]);

  // The existing flow (undefined for new)
  const existingFlow = isNew ? undefined : flowQuery.data;

  // New flow progressive disclosure gating: step 2 unlocks once the trigger
  // is fully configured, step 3 once the writer is chosen (auto-selected,
  // see below).
  const triggerComplete = triggerProblems(form.trigger).length === 0;

  // As soon as the trigger is complete, step 2 opens with the default writer
  // (ai_drafted) pre-selected so the writing surface is already visible.
  useEffect(() => {
    if (isNew && triggerComplete && !contentModeSelected) {
      setContentModeSelected(true);
    }
  }, [isNew, triggerComplete, contentModeSelected]);

  // Scroll step 2 into view when the user completes the trigger. Prefilled
  // flows (from the retention grid) are complete on mount; no scroll then.
  useEffect(() => {
    const prev = prevTriggerCompleteRef.current;
    prevTriggerCompleteRef.current = triggerComplete;
    if (prev === null) return;
    if (isNew && !prev && triggerComplete) {
      step2Ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [isNew, triggerComplete]);

  // Detect library flow (fixed-copy, no prompt, no LLM)
  const isLibraryFlow = existingFlow?.source === "library";

  // Detect person-written flow (fixed_content, created from the dashboard)
  const isFixedContentFlow = existingFlow?.content_mode === "fixed_content" && !isLibraryFlow;

  // Whether an LLM is configured (for AI draft button)
  const hasLlm = llmQuery.data?.llm !== null && llmQuery.data?.llm !== undefined;

  // prompt_source is read-only when the flow is active (422 from the API).
  // Archived flows are entirely read-only: archived is terminal.
  const promptReadOnly =
    existingFlow !== undefined &&
    (existingFlow.status === "active" || existingFlow.status === "archived");
  const flowReadOnly = existingFlow?.status === "archived";

  // Show loading state when fetching an existing flow
  if (!isNew && (flowQuery.isLoading || !initialised)) {
    return <EditorSkeleton />;
  }

  if (!isNew && flowQuery.isError) {
    return (
      <div className="mx-auto max-w-6xl">
        <div
          className="rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-[15px] text-foreground">
            Failed to load flow:{" "}
            {flowQuery.error instanceof Error
              ? flowQuery.error.message
              : "Unknown error"}
          </p>
        </div>
      </div>
    );
  }

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (key in fieldErrors) {
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next[key as string];
        return next;
      });
    }
  }

  function handlePromptChange(val: string) {
    setField("prompt_source", val);
    if (!promptDirty && existingFlow && existingFlow.prompt_source !== val) {
      setPromptDirty(true);
    }
  }

  function clearErrors() {
    setFieldErrors({});
    setBannerError(null);
    setSavedNotice(false);
  }

  function handleError(err: unknown) {
    if (err !== null && typeof err === "object" && "kind" in err) {
      const apiErr = err as FlowApiError;
      if (apiErr.kind === "validation") {
        setFieldErrors(extractFieldErrors(apiErr.issues));
      } else {
        setBannerError(apiErr.message);
      }
    } else {
      setBannerError(err instanceof Error ? err.message : "An unexpected error occurred.");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    clearErrors();

    const triggerConfig = buildTriggerConfig(form);

    if (isNew) {
      try {
        const created = await createMutation.mutateAsync({
          name: form.name,
          trigger_type: form.trigger.type,
          trigger_config: triggerConfig,
          prompt_source: form.content_mode === "ai_drafted" ? form.prompt_source : undefined,
          content_mode: form.content_mode,
          steps: [],
          approval_mode: form.approval_mode,
        });
        // Land on the edit page so the core loop (compile, activate) is
        // immediately available instead of bouncing back to the list.
        navigate(`/flows/${created.id}/edit`);
      } catch (err) {
        handleError(err);
      }
    } else {
      try {
        // The trigger is immutable after creation, so it is not sent.
        await updateMutation.mutateAsync({
          name: form.name,
          prompt_source: form.content_mode === "ai_drafted" ? form.prompt_source : undefined,
          approval_mode: form.approval_mode,
        });
        setPromptDirty(false);
        setSavedNotice(true);
      } catch (err) {
        handleError(err);
      }
    }
  }

  async function handleSavePlan() {
    if (!id) return;
    clearErrors();

    // Validate steps have content
    const emptySteps = form.steps_data.filter((s) => !s.subject.trim() || !s.body_html.trim());
    if (emptySteps.length > 0) {
      setBannerError(`Step ${emptySteps[0]!.order} is missing a subject or body.`);
      return;
    }
    if (form.steps_data.length === 0) {
      setBannerError("Add at least one step before saving the plan.");
      return;
    }

    try {
      await savePlanMutation.mutateAsync(buildPlanBody(form.steps_data) as any);
      setSavedNotice(true);
    } catch (err) {
      handleError(err);
    }
  }

  async function handleCompile() {
    setCompileError(null);
    try {
      await compileMutation.mutateAsync();
    } catch (err) {
      setCompileError(toMessage(err));
    }
  }

  async function handleTransition(status: "active" | "paused") {
    setBannerError(null);
    try {
      await statusMutation.mutateAsync(status);
    } catch (err) {
      setBannerError(toMessage(err));
    }
  }

  async function handleArchive() {
    setBannerError(null);
    try {
      await archiveMutation.mutateAsync();
      navigate("/flows");
    } catch (err) {
      setBannerError(toMessage(err));
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending || savePlanMutation.isPending;
  const transitionBusy =
    statusMutation.isPending || archiveMutation.isPending || isPending;
  const isCompiling =
    compileMutation.isPending || existingFlow?.compile_status === "pending";

  // Show the prompt-change warning only when the flow already has a compiled
  // plan and the user has dirtied the prompt field. The plan will be cleared
  // on save, so warn before, not after.
  const showPromptClearWarning =
    !promptReadOnly &&
    promptDirty &&
    existingFlow !== undefined &&
    existingFlow.compiled_plan !== null;

  const showPlan =
    !isNew &&
    existingFlow?.compile_status === "ready" &&
    existingFlow.compiled_plan !== null;

  // -------------------------------------------------------------------------
  // Library flow editor: a distinct experience for pre-built flows
  // -------------------------------------------------------------------------

  if (isLibraryFlow && existingFlow) {
    return (
      <div className="mx-auto max-w-6xl">
        {/* Back link + header */}
        <div className="mb-8">
          <Link
            to="/flows"
            className="text-[14px] text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground"
          >
            &larr; Flows
          </Link>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
              <h1 className="font-display text-[24px] font-bold leading-[30px] tracking-[-0.02em] text-foreground sm:text-[28px] sm:leading-[34px]">
                {existingFlow.name}
              </h1>
              <Badge variant={statusVariant(existingFlow.status)}>
                {existingFlow.status}
              </Badge>
              <Badge variant="muted">Fixed copy</Badge>
            </div>
            <StatusActions
              flow={existingFlow}
              busy={transitionBusy}
              onTransition={handleTransition}
              onArchive={handleArchive}
            />
          </div>
        </div>

        {/* Transition error banner */}
        {bannerError && (
          <div
            className="mb-6 rounded-md border border-danger bg-danger-soft px-4 py-3"
            role="alert"
          >
            <p className="text-[15px] text-foreground">{bannerError}</p>
          </div>
        )}

        {/* Explainer: what this flow is */}
        <div className="mb-6 rounded-md border border-border bg-sunken px-4 py-3">
          <p className="text-[14px] leading-relaxed text-foreground">
            This is a ready-made flow that sends fixed email copy from
            templates. It works without an LLM key. Click any template
            below to edit its content.
          </p>
        </div>

        <div className="flex flex-col gap-10 lg:flex-row lg:gap-8">
          {/* Main column: the plan and inline template editor */}
          <div className="min-w-0 flex-1">
            {/* Compiled plan with clickable template refs */}
            {existingFlow.compiled_plan && (
              <div>
                <p className="mb-4 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  Email sequence
                </p>
                <CompiledPlanPreview
                  plan={existingFlow.compiled_plan as UnknownRecord}
                  onEditTemplate={(slug) => setEditingTemplate(slug)}
                />
              </div>
            )}

            {/* Inline template editor */}
            {editingTemplate && (
              <div className="mt-6 rounded-lg border border-border bg-card p-6">
                <TemplateEditorBySlug
                  slug={editingTemplate}
                  onClose={() => setEditingTemplate(null)}
                />
              </div>
            )}

            {/* Upgrade path: what AI would change */}
            <div className="mt-8 rounded-md border border-border bg-sunken px-4 py-4">
              <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                What changes with an LLM key
              </p>
              <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
                With an LLM configured, you can create flows where the AI
                drafts each email for each contact individually, using your
                knowledge base for context. Every person gets a message
                written for their situation instead of the same copy.
              </p>
              <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
                This flow keeps working as-is. The AI is for new flows you
                write from a prompt.
              </p>
              <Link
                to="/settings/llm"
                className="mt-3 inline-block text-[14px] text-accent-text transition-colors hover:underline"
              >
                Configure LLM provider
              </Link>
            </div>
          </div>

          {/* Right rail: details and meta */}
          <div className="w-full shrink-0 space-y-6 lg:w-72">
            <div className="rounded-lg border border-border bg-card p-5">
              <p className="mb-4 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                Details
              </p>
              <dl className="space-y-3 text-[14px]">
                <div>
                  <dt className="text-muted-foreground">Name</dt>
                  <dd className="mt-0.5 font-medium text-foreground">{existingFlow.name}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Trigger</dt>
                  <dd className="mt-0.5 font-mono text-[13px] text-foreground">{existingFlow.trigger_type}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Content</dt>
                  <dd className="mt-0.5 text-foreground">Fixed templates (no AI)</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Approval</dt>
                  <dd className="mt-0.5 text-foreground">{existingFlow.approval_mode === "auto" ? "Automatic" : "Manual review"}</dd>
                </div>
              </dl>
            </div>

            <div className="rounded-lg border border-border bg-card p-5">
              <p className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                Meta
              </p>
              <dl className="space-y-2 text-[14px]">
                <div>
                  <dt className="text-muted-foreground">ID</dt>
                  <dd
                    className="mt-0.5 truncate font-mono text-[13px] text-muted-foreground"
                    title={existingFlow.id}
                  >
                    {existingFlow.id}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Created</dt>
                  <dd className="font-mono text-[13px] text-muted-foreground">
                    {formatDateTime(existingFlow.created_at)}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Updated</dt>
                  <dd className="font-mono text-[13px] text-muted-foreground">
                    {formatDateTime(existingFlow.updated_at)}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Prompt-defined flow editor: the primary experience
  // -------------------------------------------------------------------------

  // For fixed_content flows (person-written), show the step writing surface
  const isFixedContentEditor = isNew ? form.content_mode === "fixed_content" : isFixedContentFlow;

  // The writing surface for person-written flows. Shared by both modes; the
  // save-plan row only makes sense once the flow exists.
  const fixedContentSurface = (
    <div>
      <p className="mb-3 text-[14px] leading-relaxed text-muted-foreground">
        Write each email in the sequence below. Use {"{{variables}}"} for
        personalisation - the same copy goes to everyone with their details
        filled in. Save the plan when you are done, then activate the flow to
        start sending.
      </p>

      {/* Approval info for fixed content flows */}
      <div className="mb-6 rounded-md border border-border bg-sunken px-4 py-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div className="min-w-0">
            <p className="text-[14px] font-medium text-foreground">
              {form.approval_mode === "require"
                ? "You review each message before it sends"
                : "Approval is off"}
            </p>
            <p className="mt-1 text-[14px] leading-relaxed text-muted-foreground">
              {form.approval_mode === "require"
                ? "Each message waits for your approval before sending. Turn this off only if you fully trust the copy and the variable fallbacks."
                : "Since you wrote the copy, each message does not need individual review. Variables and fallbacks can still produce unexpected results - preview against real contacts before activating."}
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[14px] text-foreground">
            <input
              type="checkbox"
              checked={form.approval_mode === "require"}
              onChange={(e) =>
                setField("approval_mode", e.target.checked ? "require" : "auto")
              }
              disabled={isPending || flowReadOnly}
              className="h-4 w-4 accent-(--accent-deep)"
            />
            Require per-message review
          </label>
        </div>
      </div>

      <StepWriter
        flowId={id}
        steps={form.steps_data}
        onStepsChange={(steps) => setField("steps_data", steps)}
        disabled={isPending || flowReadOnly}
        hasLlm={hasLlm}
        triggerType={form.trigger.type}
        triggerConfig={buildTriggerConfig(form)}
        flowName={form.name}
      />

      {/* Save plan button */}
      {!isNew && !flowReadOnly && (
        <div className="mt-6 border-t border-border pt-6">
          <div className="flex items-center gap-3">
            <Button
              type="button"
              onClick={handleSavePlan}
              disabled={isPending || form.steps_data.length === 0}
            >
              {savePlanMutation.isPending ? "Saving plan..." : "Save plan"}
            </Button>
            {existingFlow?.compile_status === "ready" && (
              <Badge variant="success">ready</Badge>
            )}
            {savedNotice && !bannerError && (
              <span className="text-[14px] text-muted-foreground" role="status">Saved.</span>
            )}
          </div>
        </div>
      )}
    </div>
  );

  // The AI-drafted surface: the prompt, the review checkbox, and (in edit
  // mode) compile + the compiled plan.
  const aiSurface = (
    <>
      <div>
        {!isNew && <Label htmlFor="prompt-source">Prompt</Label>}
        <p className="mb-3 text-[14px] leading-relaxed text-muted-foreground">
          Describe what this flow should do, in your own words. Claros
          compiles it into a deterministic plan you review before anything is
          sent. The AI then drafts each email for each contact individually.
        </p>

        {existingFlow?.status === "active" && (
          <p
            className="mb-3 rounded-md border border-border bg-secondary px-3.5 py-2.5 text-[14px] text-muted-foreground"
            role="note"
          >
            The prompt is locked while the flow is active. Pause the flow to
            make changes.
          </p>
        )}
        {existingFlow?.status === "archived" && (
          <p
            className="mb-3 rounded-md border border-border bg-secondary px-3.5 py-2.5 text-[14px] text-muted-foreground"
            role="note"
          >
            This flow is archived. Archived is terminal; nothing here can be
            edited.
          </p>
        )}

        {showPromptClearWarning && (
          <p
            className="mb-3 rounded-md border border-warning bg-warning-soft px-3.5 py-2.5 text-[14px] text-foreground"
            role="note"
          >
            Saving will clear the existing compiled plan and reset compile
            status. You will need to recompile before activating the flow.
          </p>
        )}

        <Textarea
          id="prompt-source"
          value={form.prompt_source}
          onChange={(e) => handlePromptChange(e.target.value)}
          className="min-h-44 text-[16px] leading-relaxed"
          placeholder="When a contact becomes at-risk, send a short check-in email after two days, then a win-back offer after seven."
          disabled={isPending || promptReadOnly}
        />
        <FieldError message={fieldErrors["prompt_source"]} />

        {/* Approvals: a checkbox, not a rail setting. Review is the
            product's promise, so it lives next to the prompt. */}
        <div className="mt-5">
          <label
            htmlFor="approval-mode"
            className="flex items-center gap-2.5 text-[14px] font-medium text-foreground"
          >
            <input
              id="approval-mode"
              type="checkbox"
              checked={form.approval_mode === "require"}
              onChange={(e) =>
                setField("approval_mode", e.target.checked ? "require" : "auto")
              }
              disabled={isPending || flowReadOnly}
              className="h-4 w-4 shrink-0 accent-(--accent-deep)"
            />
            Require my review before anything sends
          </label>
          {form.approval_mode === "auto" && (
            <div
              className="mt-3 rounded-md border border-warning bg-warning-soft px-3.5 py-2.5"
              role="note"
            >
              <p className="text-[14px] leading-relaxed text-foreground">
                Review is off. Drafts from this flow will send without a human
                ever seeing them. The AI drafts from your knowledge base and
                can still get things wrong - wrong tone, wrong fact, wrong
                moment. What goes out is your responsibility.
              </p>
            </div>
          )}
          <FieldError message={fieldErrors["approval_mode"]} />
        </div>
      </div>

      {/* Compile */}
      {!isNew && existingFlow && existingFlow.status !== "archived" && (
        <div className="mt-6 border-t border-border pt-6">
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isCompiling || isPending || !existingFlow.prompt_source}
              onClick={handleCompile}
            >
              {isCompiling ? "Compiling..." : "Compile"}
            </Button>
            <Badge
              variant={compileVariant(existingFlow.compile_status)}
              pulse={existingFlow.compile_status === "pending"}
            >
              {compileLabel(existingFlow.compile_status)}
            </Badge>
            {existingFlow.compiled_at && (
              <span className="font-mono text-[13px] text-muted-foreground">
                {formatDateTime(existingFlow.compiled_at)}
              </span>
            )}
          </div>

          {/* Compile error shown verbatim - it is the provider's message
              on the tenant's own key. */}
          {existingFlow.compile_status === "failed" && existingFlow.compile_error && (
            <div
              className="mt-3 rounded-md border border-danger bg-danger-soft px-3.5 py-2.5"
              role="alert"
            >
              <p className="whitespace-pre-wrap break-words font-mono text-[13px] text-foreground">
                {existingFlow.compile_error}
              </p>
            </div>
          )}

          {/* 422 from the compile POST (archived, no prompt, no LLM config) */}
          {compileError && (
            <div
              className="mt-3 rounded-md border border-danger bg-danger-soft px-3.5 py-2.5"
              role="alert"
            >
              <p className="text-[14px] text-foreground">{compileError}</p>
            </div>
          )}
        </div>
      )}

      {/* Compiled plan */}
      {showPlan && (
        <div className="mt-6 border-t border-border pt-6">
          <p className="mb-4 text-[14px] font-medium text-foreground">
            Compiled plan
          </p>
          <CompiledPlanPreview
            plan={existingFlow.compiled_plan as UnknownRecord}
            onEditTemplate={(slug) => setEditingTemplate(slug)}
          />
        </div>
      )}

      {/* Inline template editor (for plans that reference templates) */}
      {editingTemplate && (
        <div className="mt-6 rounded-lg border border-border bg-card p-6">
          <TemplateEditorBySlug
            slug={editingTemplate}
            onClose={() => setEditingTemplate(null)}
          />
        </div>
      )}
    </>
  );

  // -------------------------------------------------------------------------
  // New flow: single column, progressive disclosure, no sidebar
  // -------------------------------------------------------------------------

  if (isNew) {
    return (
      <div className="mx-auto max-w-3xl">
        {/* Back link + name as the page title */}
        <div className="mb-10">
          <Link
            to="/flows"
            className="text-[14px] text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground"
          >
            &larr; Flows
          </Link>
          <p className="mt-6 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            New flow
          </p>
          <div className="mt-1">
            <FlowNameInput
              value={form.name}
              onChange={(v) => setField("name", v)}
              disabled={isPending}
              error={fieldErrors["name"]}
            />
          </div>
        </div>

        {/* Save error banner */}
        {bannerError && (
          <div
            className="mb-6 rounded-md border border-danger bg-danger-soft px-4 py-3"
            role="alert"
          >
            <p className="text-[15px] text-foreground">{bannerError}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          {/* Step 1: trigger */}
          <section>
            <SectionHeading
              step={1}
              title="When does this flow start?"
              description="The trigger decides which contacts enter the flow. You can change it later from the flow's page."
            />
            <div className="mt-4">
              <TriggerEditor
                draft={form.trigger}
                onChange={(d) => setField("trigger", d)}
                disabled={isPending}
                eventSuggestions={eventNamesQuery.data ?? []}
              />
            </div>
            <FieldError message={fieldErrors["trigger_type"] ?? fieldErrors["trigger_config"]} />
          </section>

          {/* Step 2: writer */}
          {triggerComplete && (
            <section ref={step2Ref} className="mt-10 scroll-mt-8">
              <SectionHeading step={2} title="Who writes the emails?" />
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  aria-pressed={form.content_mode === "fixed_content"}
                  onClick={() => {
                    setField("content_mode", "fixed_content");
                    setContentModeSelected(true);
                  }}
                  className={`rounded-lg border p-4 text-left transition-colors ${
                    form.content_mode === "fixed_content"
                      ? "border-accent bg-accent/5"
                      : "border-border bg-card hover:border-border-strong"
                  }`}
                >
                  <p className="text-[15px] font-semibold text-foreground">
                    I write them
                  </p>
                  <p className="mt-1 text-[14px] leading-relaxed text-muted-foreground">
                    Write each email once. Everyone gets the same copy,
                    personalised with variables. No LLM provider needed.
                  </p>
                </button>
                <button
                  type="button"
                  aria-pressed={form.content_mode === "ai_drafted"}
                  onClick={() => {
                    setField("content_mode", "ai_drafted");
                    setContentModeSelected(true);
                  }}
                  className={`rounded-lg border p-4 text-left transition-colors ${
                    form.content_mode === "ai_drafted"
                      ? "border-accent bg-accent/5"
                      : "border-border bg-card hover:border-border-strong"
                  }`}
                >
                  <p className="text-[15px] font-semibold text-foreground">
                    AI drafts each one
                  </p>
                  <p className="mt-1 text-[14px] leading-relaxed text-muted-foreground">
                    Describe what you want. The AI drafts a unique email for
                    each contact using their context. Requires an LLM provider.
                  </p>
                </button>
              </div>
            </section>
          )}

          {/* Step 3: content */}
          {triggerComplete && contentModeSelected && (
            <section ref={step3Ref} className="mt-10 scroll-mt-8">
              <SectionHeading
                step={3}
                title={isFixedContentEditor ? "Write the sequence" : "Describe the flow"}
              />
              <div className="mt-5">
                {isFixedContentEditor ? fixedContentSurface : aiSurface}
              </div>
            </section>
          )}

          {/* Create row */}
          {triggerComplete && contentModeSelected && (
            <div className="mt-10 flex items-center gap-3 border-t border-border pt-6">
              <Button type="submit" disabled={isPending}>
                {isPending ? "Creating..." : "Create flow"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => navigate("/flows")}
                disabled={isPending}
              >
                Cancel
              </Button>
            </div>
          )}
        </form>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Edit flow: name as title, read-only trigger, meta-only rail
  // -------------------------------------------------------------------------

  return (
    <div className="mx-auto max-w-6xl">
      {/* Back link + header */}
      <div className="mb-8">
        <Link
          to="/flows"
          className="text-[14px] text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground"
        >
          &larr; Flows
        </Link>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="flex min-w-0 flex-1 flex-wrap items-start gap-3">
            <FlowNameInput
              value={form.name}
              onChange={(v) => setField("name", v)}
              disabled={isPending || flowReadOnly}
              error={fieldErrors["name"]}
            />
            <div className="flex shrink-0 items-center gap-2 pt-2">
              {existingFlow && (
                <Badge variant={statusVariant(existingFlow.status)}>
                  {existingFlow.status}
                </Badge>
              )}
              {existingFlow && !isFixedContentFlow && (
                <Badge variant="neutral">AI-drafted</Badge>
              )}
              {isFixedContentFlow && (
                <Badge variant="muted">Person-written</Badge>
              )}
            </div>
          </div>
          {existingFlow && (
            <div className="shrink-0 pt-0 sm:pt-2">
              <StatusActions
                flow={existingFlow}
                busy={transitionBusy}
                onTransition={handleTransition}
                onArchive={handleArchive}
              />
            </div>
          )}
        </div>
      </div>

      {/* Save / transition error banner */}
      {bannerError && (
        <div
          className="mb-6 rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-[15px] text-foreground">{bannerError}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <div className="flex flex-col gap-10 lg:flex-row lg:gap-8">
          {/* Main column */}
          <div className="min-w-0 flex-1">
            {existingFlow && !editingTrigger && (
              <TriggerSummary flow={existingFlow} onEdit={flowReadOnly ? undefined : () => setEditingTrigger(true)} />
            )}
            {existingFlow && editingTrigger && (
              <TriggerEditCard flow={existingFlow} suggestions={eventNamesQuery.data ?? []} onDone={() => setEditingTrigger(false)} />
            )}
            {existingFlow && <FlowTopicPicker flow={existingFlow} disabled={flowReadOnly} />}

            <div className="mt-8">
              {isFixedContentEditor ? fixedContentSurface : aiSurface}
            </div>

            {existingFlow && !flowReadOnly && (
              <div className="mt-8 rounded-lg border border-border bg-card p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[15px] font-semibold text-foreground">Plan editor</p>
                    <p className="mt-0.5 text-[13px] text-muted-foreground">
                      Write the steps out: choose steps, context sources, knowledge base, sender name, eyebrow and preheader, links, expiry and conditions.
                      {existingFlow.prompt_source ? " Saving replaces the compiled plan until the prompt is compiled again." : ""}
                    </p>
                  </div>
                  <Button type="button" size="sm" variant="outline" onClick={() => setPlanEditorOpen((v) => !v)}>
                    {planEditorOpen ? "Close" : "Open"}
                  </Button>
                </div>
                {planEditorOpen && (
                  <div className="mt-5">
                    <PlanEditor
                      key={existingFlow.compiled_at ?? "none"}
                      initial={planFromFlow(existingFlow.compiled_plan, existingFlow.steps)}
                      saving={saveStepsMutation.isPending}
                      onSave={async (body) => {
                        await saveStepsMutation.mutateAsync(body);
                      }}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Save row */}
            {!flowReadOnly && (
              <div className="mt-8 flex items-center gap-3 border-t border-border pt-6">
                <Button type="submit" disabled={isPending}>
                  {isPending ? "Saving..." : "Save changes"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => navigate("/flows")}
                  disabled={isPending}
                >
                  Cancel
                </Button>
                {savedNotice && !bannerError && (
                  <span className="text-[14px] text-muted-foreground" role="status">
                    Saved.
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Right rail: flow settings and meta */}
          {existingFlow && (
            <div className="w-full shrink-0 space-y-6 lg:w-72">
              <FlowSettingsCard flow={existingFlow} disabled={flowReadOnly} />
              <div className="rounded-lg border border-border bg-card p-5">
                <p className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  Meta
                </p>
                <dl className="space-y-2 text-[14px]">
                  <div>
                    <dt className="text-muted-foreground">ID</dt>
                    <dd
                      className="mt-0.5 truncate font-mono text-[13px] text-muted-foreground"
                      title={existingFlow.id}
                    >
                      {existingFlow.id}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Created</dt>
                    <dd className="font-mono text-[13px] text-muted-foreground">
                      {formatDateTime(existingFlow.created_at)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Updated</dt>
                    <dd className="font-mono text-[13px] text-muted-foreground">
                      {formatDateTime(existingFlow.updated_at)}
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          )}
        </div>
      </form>
    </div>
  );
}
