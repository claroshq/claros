/**
 * Step writer - the writing surface for person-written (fixed_content) flows.
 *
 * Each step has: order, delay, action_type, subject, body_html, body_text.
 * The component builds a valid compiled plan from the steps and submits it
 * to POST /v1/flows/:id/plan.
 *
 * Features:
 *   - Add/remove/reorder steps
 *   - Subject and body HTML editing per step (reusing the template-editor pattern)
 *   - Clickable variable chips that insert {{...}} at the cursor position of
 *     the last focused field (subject, HTML body, or plain-text body)
 *   - AI draft button per step (calls POST /v1/flows/:id/draft-step)
 *   - Live preview rendered as an email card, with variables substituted
 *     by sample contact data
 */
import React, { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Select } from "./ui/select.js";
import { Textarea } from "./ui/textarea.js";
import { Badge } from "./ui/badge.js";
import { draftFlowStep, type DraftStepResult } from "../api.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StepData {
  order: number;
  delay: string;
  action_type: string;
  subject: string;
  body_html: string;
  body_text: string;
  window_policy: "immediate" | "respect_window";
}

interface StepWriterProps {
  flowId: string | undefined;
  steps: StepData[];
  onStepsChange: (steps: StepData[]) => void;
  disabled?: boolean;
  /** Whether an LLM is configured (controls AI draft button visibility) */
  hasLlm: boolean;
  /** Flow trigger type and config for AI context */
  triggerType?: string;
  triggerConfig?: Record<string, unknown>;
  flowName?: string;
}

// Available template variables (same as template-editor.tsx)
const TEMPLATE_VARIABLES = [
  "contact.first_name",
  "contact.name",
  "contact.email",
  "contact.company",
  "tenant.name",
] as const;

const ACTION_TYPE_OPTIONS = [
  { value: "onboard_welcome", label: "Welcome" },
  { value: "onboard_getting_started", label: "Getting started" },
  { value: "nurture_value", label: "Value nurture" },
  { value: "nurture_education", label: "Education" },
  { value: "reengage_check_in", label: "Check-in" },
  { value: "reengage_offer", label: "Win-back offer" },
  { value: "critical_dunning", label: "Dunning" },
  { value: "critical_security", label: "Security alert" },
] as const;

const DELAY_PRESETS = [
  { value: "0m", label: "Immediately" },
  { value: "1h", label: "1 hour" },
  { value: "2h", label: "2 hours" },
  { value: "1d", label: "1 day" },
  { value: "2d", label: "2 days" },
  { value: "3d", label: "3 days" },
  { value: "5d", label: "5 days" },
  { value: "7d", label: "7 days" },
  { value: "14d", label: "14 days" },
] as const;

// ---------------------------------------------------------------------------
// Variable chips + preview substitution
// ---------------------------------------------------------------------------

// Sample data used only in the local preview. Real values are filled in per
// contact at send time.
const SAMPLE_VARIABLES: Record<string, string> = {
  "contact.first_name": "Ada",
  "contact.name": "Ada Lovelace",
  "contact.email": "ada@example.com",
  "contact.company": "Acme Inc.",
  "tenant.name": "Claros",
};

/**
 * Replace {{var}} and {{var|fallback}} tokens with sample values so the
 * preview reads like a real email. Unknown tokens are left as-is.
 */
function substituteVariables(text: string): string {
  return text.replace(
    /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|([^}]*))?\}\}/g,
    (match, key: string, fallback: string | undefined) => {
      const sample = SAMPLE_VARIABLES[key.trim()];
      if (sample !== undefined) return sample;
      if (fallback !== undefined) return fallback.trim();
      return match;
    },
  );
}

function VariableChips({
  onInsert,
  disabled,
}: {
  onInsert: (variable: string) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[12px] font-medium text-muted-foreground">
          Insert variable:
        </span>
        {TEMPLATE_VARIABLES.map((v) => (
          <button
            key={v}
            type="button"
            disabled={disabled}
            // Keep focus in the field so the cursor position survives the click.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onInsert(v)}
            title={`Insert {{${v}}} at the cursor`}
            className="rounded border border-border bg-sunken px-2 py-0.5 font-mono text-[12px] text-foreground transition-colors hover:border-border-strong hover:bg-bg-raised disabled:opacity-50"
          >
            {`{{${v}}}`}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Inserts at the cursor of the field you last typed in. Use the pipe
        syntax for fallbacks: {"{{contact.first_name|there}}"}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single step editor
// ---------------------------------------------------------------------------

interface StepEditorProps {
  step: StepData;
  totalSteps: number;
  onUpdate: (step: StepData) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  disabled?: boolean;
  flowId: string | undefined;
  hasLlm: boolean;
}

function StepEditor({
  step,
  totalSteps,
  onUpdate,
  onRemove,
  onMoveUp,
  onMoveDown,
  disabled,
  flowId,
  hasLlm,
}: StepEditorProps) {
  const [previewMode, setPreviewMode] = useState<"html" | "text">("html");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  // Which field a variable chip should target: the subject input or the
  // currently visible body textarea.
  const lastFocusedRef = useRef<"subject" | "body">("body");

  function insertVariable(variable: string) {
    const token = `{{${variable}}}`;
    const field: "subject" | "body_html" | "body_text" =
      lastFocusedRef.current === "subject"
        ? "subject"
        : previewMode === "text"
          ? "body_text"
          : "body_html";
    const el =
      field === "subject"
        ? subjectRef.current
        : field === "body_text"
          ? textRef.current
          : bodyRef.current;
    const current = step[field];
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const next = current.slice(0, start) + token + current.slice(end);
    onUpdate({ ...step, [field]: next });
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        el.setSelectionRange(start + token.length, start + token.length);
      }
    });
  }

  const draftMutation = useMutation({
    mutationFn: (input: { step_order: number; subject?: string; body_html?: string }) =>
      draftFlowStep(flowId!, input),
    onSuccess: (result: DraftStepResult) => {
      // Only update if the person hasn't written content, or confirm overwrite
      if (step.subject || step.body_html) {
        // Content exists - replace it (the person clicked the button knowingly)
        onUpdate({ ...step, subject: result.subject, body_html: result.body_html });
      } else {
        onUpdate({ ...step, subject: result.subject, body_html: result.body_html });
      }
      setDraftError(null);
    },
    onError: (err: unknown) => {
      const msg = err !== null && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message)
        : "AI draft failed.";
      setDraftError(msg);
    },
  });

  function handleDraft() {
    if (!flowId) return;
    setDraftError(null);
    draftMutation.mutate({
      step_order: step.order,
      subject: step.subject || undefined,
      body_html: step.body_html || undefined,
    });
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      {/* Step header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-sunken font-mono text-[12px] text-muted-foreground">
            {step.order}
          </span>
          <span className="text-[14px] font-medium text-foreground">
            Step {step.order}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={disabled || step.order === 1}
            className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
            title="Move up"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={disabled || step.order === totalSteps}
            className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
            title="Move down"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled || totalSteps <= 1}
            className="ml-2 rounded p-1 text-muted-foreground hover:text-danger disabled:opacity-30"
            title="Remove step"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Delay + action type row */}
      <div className="mb-4 flex gap-4">
        <div className="flex-1">
          <label className="mb-1 block text-[13px] font-medium text-foreground">
            Send after
          </label>
          <Select
            value={step.delay}
            onChange={(e) => onUpdate({ ...step, delay: e.target.value })}
            disabled={disabled}
          >
            {DELAY_PRESETS.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </Select>
        </div>
        <div className="flex-1">
          <label className="mb-1 block text-[13px] font-medium text-foreground">
            Email type
          </label>
          <Select
            value={step.action_type}
            onChange={(e) => onUpdate({ ...step, action_type: e.target.value })}
            disabled={disabled}
          >
            {ACTION_TYPE_OPTIONS.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </Select>
        </div>
        <div className="flex-1">
          <label className="mb-1 block text-[13px] font-medium text-foreground">
            Send window
          </label>
          <Select
            value={step.window_policy}
            onChange={(e) => onUpdate({ ...step, window_policy: e.target.value as "immediate" | "respect_window" })}
            disabled={disabled}
          >
            <option value="respect_window">Respect send window</option>
            <option value="immediate">Send immediately (bypass window)</option>
          </Select>
        </div>
      </div>

      {/* Variable chips */}
      <div className="mb-4">
        <VariableChips onInsert={insertVariable} disabled={disabled} />
      </div>

      {/* Subject */}
      <div className="mb-4">
        <label className="mb-1 block text-[13px] font-medium text-foreground">
          Subject line
        </label>
        <Input
          ref={subjectRef}
          value={step.subject}
          onChange={(e) => onUpdate({ ...step, subject: e.target.value })}
          onFocus={() => {
            lastFocusedRef.current = "subject";
          }}
          placeholder="e.g. {{contact.first_name|Hi there}}, here is your next step"
          disabled={disabled}
        />
      </div>

      {/* Body editor */}
      <div className="mb-4">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-[13px] font-medium text-foreground">
            Body
          </label>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setPreviewMode("html")}
              className={`rounded px-2 py-1 text-[12px] ${previewMode === "html" ? "bg-selected font-semibold text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              HTML
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
            ref={bodyRef}
            value={step.body_html}
            onChange={(e) => onUpdate({ ...step, body_html: e.target.value })}
            onFocus={() => {
              lastFocusedRef.current = "body";
            }}
            disabled={disabled}
            rows={8}
            className="font-mono text-[13px]"
            placeholder="<p>Hi {{contact.first_name|there}},</p>&#10;<p>Write your email content here...</p>"
          />
        ) : (
          <Textarea
            ref={textRef}
            value={step.body_text}
            onChange={(e) => onUpdate({ ...step, body_text: e.target.value })}
            onFocus={() => {
              lastFocusedRef.current = "body";
            }}
            disabled={disabled}
            rows={8}
            placeholder="Optional plain-text version. If empty, the system derives it from HTML."
          />
        )}
      </div>

      {/* AI draft button + preview toggle */}
      <div className="flex items-center gap-3">
        {hasLlm && flowId ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || draftMutation.isPending}
            onClick={handleDraft}
          >
            {draftMutation.isPending ? "Drafting..." : "AI draft"}
          </Button>
        ) : !hasLlm ? (
          <span className="text-[13px] text-muted-foreground">
            AI drafting requires an LLM provider (Settings)
          </span>
        ) : null}

        <button
          type="button"
          onClick={() => setShowPreview(!showPreview)}
          className="text-[13px] text-accent-text hover:underline"
        >
          {showPreview ? "Hide preview" : "Preview"}
        </button>
      </div>

      {/* Draft error */}
      {draftError && (
        <p className="mt-2 rounded-md border border-danger bg-danger-soft px-3 py-2 text-[13px] text-foreground">
          {draftError}
        </p>
      )}

      {/* Preview rendered as an email card, variables substituted with
          sample data so it reads like the real thing. */}
      {showPreview && (step.subject || step.body_html) && (
        <div className="mt-3 rounded-md border border-border bg-sunken p-4">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Preview with sample data
          </p>
          <div className="rounded-md border border-border bg-white">
            <div className="border-b border-border px-5 py-3">
              <p className="text-[15px] font-semibold text-foreground">
                {step.subject
                  ? substituteVariables(step.subject)
                  : "(no subject)"}
              </p>
            </div>
            <div
              className="px-5 py-4 text-[14px] leading-relaxed text-foreground"
              dangerouslySetInnerHTML={{
                __html: substituteVariables(step.body_html),
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main step writer component
// ---------------------------------------------------------------------------

export function StepWriter({
  flowId,
  steps,
  onStepsChange,
  disabled,
  hasLlm,
}: StepWriterProps) {
  function addStep() {
    const newOrder = steps.length + 1;
    const defaultDelay = newOrder === 1 ? "0m" : "2d";
    onStepsChange([
      ...steps,
      {
        order: newOrder,
        delay: defaultDelay,
        action_type: "nurture_value",
        subject: "",
        body_html: "",
        body_text: "",
        window_policy: "respect_window",
      },
    ]);
  }

  function removeStep(order: number) {
    const filtered = steps.filter((s) => s.order !== order);
    // Re-number
    const renumbered = filtered.map((s, i) => ({ ...s, order: i + 1 }));
    onStepsChange(renumbered);
  }

  function updateStep(order: number, updated: StepData) {
    onStepsChange(steps.map((s) => (s.order === order ? updated : s)));
  }

  function moveStep(order: number, direction: "up" | "down") {
    const idx = steps.findIndex((s) => s.order === order);
    if (idx < 0) return;
    const newIdx = direction === "up" ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= steps.length) return;
    const copy = [...steps];
    [copy[idx], copy[newIdx]] = [copy[newIdx]!, copy[idx]!];
    // Re-number
    const renumbered = copy.map((s, i) => ({ ...s, order: i + 1 }));
    onStepsChange(renumbered);
  }

  return (
    <div className="space-y-6">
      {steps.length === 0 && (
        <div className="rounded-md border border-border bg-sunken px-4 py-6 text-center">
          <p className="text-[14px] text-muted-foreground">
            No steps yet. Add your first email below.
          </p>
        </div>
      )}

      {steps.map((step) => (
        <StepEditor
          key={step.order}
          step={step}
          totalSteps={steps.length}
          onUpdate={(updated) => updateStep(step.order, updated)}
          onRemove={() => removeStep(step.order)}
          onMoveUp={() => moveStep(step.order, "up")}
          onMoveDown={() => moveStep(step.order, "down")}
          disabled={disabled}
          flowId={flowId}
          hasLlm={hasLlm}
        />
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={addStep}
        disabled={disabled}
      >
        Add step
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper: build plan body for POST /v1/flows/:id/plan
// ---------------------------------------------------------------------------

export function buildPlanBody(
  steps: StepData[],
): { steps: Array<{ order: number; delay: string; action_type: string; window_policy: string; subject: string; body_html: string; body_text?: string }> } {
  return {
    steps: steps.map((s) => ({
      order: s.order,
      delay: s.delay,
      action_type: s.action_type,
      window_policy: s.window_policy,
      subject: s.subject,
      body_html: s.body_html,
      ...(s.body_text ? { body_text: s.body_text } : {}),
    })),
  };
}
