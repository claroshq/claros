/**
 * Plan editor: every field of a flow's steps, written as explicit steps
 * (PUT /v1/flows/:id/steps). Covers send and choose steps, sender fields
 * (from name, reply-to, eyebrow, preheader), links (allowed_links,
 * single_cta), conditions with all / any / not, expiry, context sources,
 * knowledge base selection and choose candidates, plus the plan's exit
 * conditions. A JSON mode edits the whole plan as text.
 */
import React, { useState } from "react";
import {
  cleanStep,
  nextOrder,
  stepProblems,
  summarizeCondition,
  toConditionList,
  type Condition,
  type Json,
} from "../lib/flow-model.js";
import { ConditionListEditor } from "./condition-builder.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Select } from "./ui/select.js";
import { Textarea } from "./ui/textarea.js";
import { Badge } from "./ui/badge.js";

const LABEL = "mb-1 block text-[13px] font-medium text-foreground";
const HINT = "mt-1 text-[12px] text-muted-foreground";

export interface PlanValue {
  steps: Json[];
  exit_conditions: Condition[];
}

/** The plan a flow has now, as editable values. */
export function planFromFlow(compiledPlan: Json | null, steps: unknown): PlanValue {
  const planSteps = compiledPlan && Array.isArray(compiledPlan.steps) ? (compiledPlan.steps as Json[]) : Array.isArray(steps) ? (steps as Json[]) : [];
  const exits = compiledPlan && Array.isArray(compiledPlan.exit_conditions) ? (compiledPlan.exit_conditions as Condition[]) : [];
  return { steps: planSteps.map((s) => ({ ...s })), exit_conditions: exits };
}

/** The request body for PUT /v1/flows/:id/steps. */
export function planBody(plan: PlanValue): { steps: Json[]; exit_conditions?: Condition[] } {
  const steps = plan.steps.map(cleanStep);
  return plan.exit_conditions.length > 0 ? { steps, exit_conditions: plan.exit_conditions } : { steps };
}

function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <p className={LABEL}>{label}</p>
      {children}
      {hint && <p className={HINT}>{hint}</p>}
    </div>
  );
}

function text(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

/** Comma-separated names kept as typed. */
function NamesInput({ value, onChange, placeholder, disabled, label }: { value: unknown; onChange: (v: string[] | undefined) => void; placeholder?: string; disabled?: boolean; label: string }) {
  const [raw, setRaw] = useState(Array.isArray(value) ? (value as string[]).join(", ") : "");
  return (
    <Input
      aria-label={label}
      className="h-9 text-[13px]"
      value={raw}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => {
        setRaw(e.target.value);
        const names = e.target.value.split(",").map((s) => s.trim()).filter((s) => s !== "");
        onChange(names.length > 0 ? names : undefined);
      }}
    />
  );
}

function ContextList({ value, onChange, disabled }: { value: unknown; onChange: (v: Json[] | undefined) => void; disabled?: boolean }) {
  const items = Array.isArray(value) ? (value as Json[]) : [];
  const set = (next: Json[]) => onChange(next.length > 0 ? next : undefined);
  return (
    <div className="space-y-2">
      {items.map((c, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input aria-label="Data source" className="h-8 w-36 text-[13px]" placeholder="source" value={text(c.source)} disabled={disabled} onChange={(e) => set(items.map((x, j) => (j === i ? { ...x, source: e.target.value } : x)))} />
          <Input aria-label="Mode" className="h-8 w-32 text-[13px]" placeholder="mode" value={text(c.mode)} disabled={disabled} onChange={(e) => set(items.map((x, j) => (j === i ? { ...x, mode: e.target.value || undefined } : x)))} />
          <Input aria-label="Limit" type="number" min={1} max={100} className="h-8 w-24 text-[13px]" placeholder="limit" value={text(c.limit)} disabled={disabled} onChange={(e) => set(items.map((x, j) => (j === i ? { ...x, limit: e.target.value === "" ? undefined : Number(e.target.value) } : x)))} />
          <Button type="button" size="sm" variant="ghost" className="h-8" disabled={disabled} onClick={() => set(items.filter((_, j) => j !== i))}>Remove</Button>
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" className="h-8" disabled={disabled || items.length >= 5} onClick={() => set([...items, { source: "" }])}>Add context source</Button>
    </div>
  );
}

function KbSelectFields({ value, onChange, disabled }: { value: unknown; onChange: (v: Json | undefined) => void; disabled?: boolean }) {
  const kb = value && typeof value === "object" ? (value as Json) : null;
  if (!kb) {
    return <Button type="button" size="sm" variant="outline" className="h-8" disabled={disabled} onClick={() => onChange({ category: "" })}>Pick a knowledge base entry</Button>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input aria-label="KB category" className="h-8 w-36 text-[13px]" placeholder="category" value={text(kb.category)} disabled={disabled} onChange={(e) => onChange({ ...kb, category: e.target.value })} />
      <Select aria-label="KB pick" className="h-8 w-40 text-[13px]" value={text(kb.pick) || "oldest_unused"} disabled={disabled} onChange={(e) => onChange({ ...kb, pick: e.target.value })}>
        <option value="oldest_unused">oldest unused</option>
        <option value="best_match">best match</option>
      </Select>
      <Input aria-label="Tags from trait" className="h-8 w-40 text-[13px]" placeholder="tags from trait" value={text(kb.tags_any_from_trait)} disabled={disabled} onChange={(e) => onChange({ ...kb, tags_any_from_trait: e.target.value || undefined })} />
      <label className="flex items-center gap-1.5 text-[13px] text-foreground">
        <input type="checkbox" checked={kb.exclude_used !== false} disabled={disabled} onChange={(e) => onChange({ ...kb, exclude_used: e.target.checked ? undefined : false })} />
        never the same entry twice
      </label>
      <Button type="button" size="sm" variant="ghost" className="h-8" disabled={disabled} onClick={() => onChange(undefined)}>Remove</Button>
    </div>
  );
}

function CandidateCard({ value, onChange, onRemove, disabled }: { value: Json; onChange: (c: Json) => void; onRemove: () => void; disabled?: boolean }) {
  const set = (patch: Json) => onChange({ ...value, ...patch });
  return (
    <div className="space-y-3 rounded-md border border-border bg-sunken p-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Action type">
          <Input aria-label="Candidate action type" className="h-8 w-44 text-[13px]" value={text(value.action_type)} placeholder="tip_trick" disabled={disabled} onChange={(e) => set({ action_type: e.target.value })} />
        </Field>
        <Field label="Cooldown">
          <Input aria-label="Cooldown" className="h-8 w-24 text-[13px]" value={text(value.cooldown)} placeholder="14d" disabled={disabled} onChange={(e) => set({ cooldown: e.target.value || undefined })} />
        </Field>
        <Field label="Template (fixed copy)">
          <Input aria-label="Candidate template" className="h-8 w-40 text-[13px]" value={text(value.template_ref)} placeholder="template slug" disabled={disabled} onChange={(e) => set({ template_ref: e.target.value || undefined })} />
        </Field>
        <Field label="Eyebrow">
          <Input aria-label="Candidate eyebrow" className="h-8 w-36 text-[13px]" value={text(value.eyebrow)} maxLength={60} disabled={disabled} onChange={(e) => set({ eyebrow: e.target.value || undefined })} />
        </Field>
        <Button type="button" size="sm" variant="ghost" className="ml-auto h-8" disabled={disabled} onClick={onRemove}>Remove candidate</Button>
      </div>
      <Field label="Instruction (default: the step's)">
        <Textarea aria-label="Candidate instruction" className="min-h-16 text-[13px]" value={text(value.brain_instruction)} disabled={disabled} onChange={(e) => set({ brain_instruction: e.target.value || undefined })} />
      </Field>
      <Field label="Allowed links" hint="Names from settings.links, comma separated.">
        <NamesInput label="Candidate allowed links" value={value.allowed_links} onChange={(v) => set({ allowed_links: v })} placeholder="dashboard_url" disabled={disabled} />
      </Field>
      <Field label="Knowledge base">
        <KbSelectFields value={value.kb_select} onChange={(v) => set({ kb_select: v })} disabled={disabled} />
      </Field>
      <Field label="Context sources">
        <ContextList value={value.context} onChange={(v) => set({ context: v })} disabled={disabled} />
      </Field>
      <ConditionListEditor label="Eligible when" value={toConditionList(value.when)} onChange={(l) => set({ when: l.length > 0 ? l : undefined })} scope="contact" disabled={disabled} />
    </div>
  );
}

function StepCard({ step, onChange, onRemove, disabled }: { step: Json; onChange: (s: Json) => void; onRemove: () => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const set = (patch: Json) => onChange({ ...step, ...patch });
  const isChoose = step.type === "choose";
  const candidates = Array.isArray(step.candidates) ? (step.candidates as Json[]) : [];

  return (
    <li className="rounded-lg border border-border bg-card">
      <button type="button" className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-full border border-border-strong font-mono text-[12px] text-muted-foreground">{text(step.order)}</span>
        <code className="font-mono text-[13px] text-foreground">{text(step.action_type) || "(no action type)"}</code>
        <span className="text-[13px] text-muted-foreground">after {text(step.delay) || "?"}</span>
        {isChoose && <Badge variant="accent">choose</Badge>}
        {typeof step.template_ref === "string" && <Badge variant="muted">fixed copy</Badge>}
        {step.condition !== undefined && <span className="text-[12px] text-muted-foreground">if {summarizeCondition(step.condition)}</span>}
        <span className="ml-auto text-[12px] text-accent-text">{open ? "Close" : "Edit"}</span>
      </button>
      {open && (
        <div className="space-y-4 px-4 pb-4 pt-1">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Order">
              <Input aria-label="Order" type="number" min={1} className="h-9 text-[13px]" value={text(step.order)} disabled={disabled} onChange={(e) => set({ order: Number(e.target.value) })} />
            </Field>
            <Field label="Action type">
              <Input aria-label="Action type" className="h-9 text-[13px]" value={text(step.action_type)} disabled={disabled} onChange={(e) => set({ action_type: e.target.value })} />
            </Field>
            <Field label="Delay">
              <Input aria-label="Delay" className="h-9 text-[13px]" value={text(step.delay)} placeholder="0m, 2h, 3d" disabled={disabled} onChange={(e) => set({ delay: e.target.value })} />
            </Field>
            <Field label="Send window">
              <Select aria-label="Window policy" className="h-9 text-[13px]" value={text(step.window_policy) || "respect_window"} disabled={disabled} onChange={(e) => set({ window_policy: e.target.value })}>
                <option value="respect_window">inside the window</option>
                <option value="immediate">immediately</option>
              </Select>
            </Field>
            <Field label="Step type">
              <Select aria-label="Step type" className="h-9 text-[13px]" value={isChoose ? "choose" : "send"} disabled={disabled} onChange={(e) => set(e.target.value === "choose" ? { type: "choose", candidates: candidates.length > 0 ? candidates : [{ action_type: "" }] } : { type: undefined, candidates: undefined, allow_none: undefined })}>
                <option value="send">send</option>
                <option value="choose">choose (the AI picks a candidate)</option>
              </Select>
            </Field>
            <Field label="Template (fixed copy)">
              <Input aria-label="Template" className="h-9 text-[13px]" value={text(step.template_ref)} placeholder="template slug" disabled={disabled} onChange={(e) => set({ template_ref: e.target.value || undefined })} />
            </Field>
            <Field label="Expires after">
              <Input aria-label="Expires after" className="h-9 text-[13px]" value={text(step.expires_after)} placeholder="2d" disabled={disabled} onChange={(e) => set({ expires_after: e.target.value || undefined })} />
            </Field>
          </div>

          <Field label="Instruction for the AI" hint="Without a template the AI drafts the email from this. Variables such as {{links.icp_url}} and {{event.plan}} work here.">
            <Textarea aria-label="Instruction" className="min-h-20 text-[13px]" value={text(step.brain_instruction)} disabled={disabled} onChange={(e) => set({ brain_instruction: e.target.value || undefined })} />
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="From name" hint="Display name only; the address stays the product's sender.">
              <Input aria-label="From name" className="h-9 text-[13px]" value={text(step.from_name)} maxLength={120} disabled={disabled} onChange={(e) => set({ from_name: e.target.value || undefined })} />
            </Field>
            <Field label="Reply-to">
              <Input aria-label="Reply-to" className="h-9 text-[13px]" value={text(step.reply_to)} placeholder="founder@example.com" disabled={disabled} onChange={(e) => set({ reply_to: e.target.value || undefined })} />
            </Field>
            <Field label="Eyebrow" hint="Small label above the heading.">
              <Input aria-label="Eyebrow" className="h-9 text-[13px]" value={text(step.eyebrow)} maxLength={60} disabled={disabled} onChange={(e) => set({ eyebrow: e.target.value || undefined })} />
            </Field>
            <Field label="Preheader" hint="Hidden inbox preview text.">
              <Input aria-label="Preheader" className="h-9 text-[13px]" value={text(step.preheader)} maxLength={200} disabled={disabled} onChange={(e) => set({ preheader: e.target.value || undefined })} />
            </Field>
            <Field label="Allowed links" hint="Names from settings.links, comma separated. Empty: every named link.">
              <NamesInput label="Allowed links" value={step.allowed_links} onChange={(v) => set({ allowed_links: v })} placeholder="icp_url, settings_url" disabled={disabled} />
            </Field>
            <div className="flex items-end">
              <label className="flex items-center gap-2 pb-2 text-[13px] text-foreground">
                <input type="checkbox" checked={step.single_cta === true} disabled={disabled} onChange={(e) => set({ single_cta: e.target.checked ? true : undefined })} />
                At most one link (besides footer and unsubscribe)
              </label>
            </div>
          </div>

          <Field label="Knowledge base">
            <KbSelectFields value={step.kb_select} onChange={(v) => set({ kb_select: v })} disabled={disabled} />
          </Field>

          <Field label="Context sources" hint="Data fetched from your app when the email is written (settings.data_sources).">
            <ContextList value={step.context} onChange={(v) => set({ context: v })} disabled={disabled} />
          </Field>
          {Array.isArray(step.context) && (step.context as unknown[]).length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:w-1/2">
              <Field label="When empty">
                <Select aria-label="On empty" className="h-9 text-[13px]" value={text(step.on_empty) || "send"} disabled={disabled} onChange={(e) => set({ on_empty: e.target.value })}>
                  <option value="send">send anyway</option>
                  <option value="skip">skip the email</option>
                </Select>
              </Field>
              <Field label="On error">
                <Select aria-label="On error" className="h-9 text-[13px]" value={text(step.on_error) || "defer"} disabled={disabled} onChange={(e) => set({ on_error: e.target.value })}>
                  <option value="defer">retry later</option>
                  <option value="skip">skip the email</option>
                  <option value="fail">fail the email</option>
                </Select>
              </Field>
            </div>
          )}

          <ConditionListEditor label="Send only if" value={toConditionList(step.condition)} onChange={(l) => set({ condition: l.length > 0 ? l : undefined })} scope="step" disabled={disabled} />
          <ConditionListEditor label="Exit the flow if" value={toConditionList(step.exit_condition)} onChange={(l) => set({ exit_condition: l.length > 0 ? l : undefined })} scope="step" disabled={disabled} />

          {isChoose && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[13px] font-medium text-foreground">Candidates</p>
                <label className="flex items-center gap-2 text-[13px] text-foreground">
                  <input type="checkbox" checked={step.allow_none !== false} disabled={disabled} onChange={(e) => set({ allow_none: e.target.checked ? undefined : false })} />
                  The AI may choose none
                </label>
              </div>
              {candidates.map((c, i) => (
                <CandidateCard
                  key={i}
                  value={c}
                  disabled={disabled}
                  onChange={(next) => set({ candidates: candidates.map((x, j) => (j === i ? next : x)) })}
                  onRemove={() => set({ candidates: candidates.filter((_, j) => j !== i) })}
                />
              ))}
              <Button type="button" size="sm" variant="outline" className="h-8" disabled={disabled || candidates.length >= 20} onClick={() => set({ candidates: [...candidates, { action_type: "" }] })}>
                Add candidate
              </Button>
            </div>
          )}

          <div className="flex justify-end">
            <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onRemove}>Remove step</Button>
          </div>
        </div>
      )}
    </li>
  );
}

/** Messages of a failed save (validation issues one per line). */
function saveErrors(err: unknown): string[] {
  if (err && typeof err === "object" && "kind" in err) {
    const e = err as { kind: string; issues?: Array<{ path: string; message: string }>; message?: string };
    if (e.kind === "validation" && e.issues) return e.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message));
    if (e.message) return [e.message];
  }
  return [err instanceof Error ? err.message : "Saving failed."];
}

interface PlanEditorProps {
  initial: PlanValue;
  onSave: (body: { steps: Json[]; exit_conditions?: Condition[] }) => Promise<void>;
  saving: boolean;
  disabled?: boolean;
}

export function PlanEditor({ initial, onSave, saving, disabled }: PlanEditorProps) {
  const [plan, setPlan] = useState<PlanValue>(initial);
  const [json, setJson] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaved(false);
    let current = plan;
    if (json !== null) {
      try {
        const parsed = JSON.parse(json) as { steps?: unknown; exit_conditions?: unknown };
        if (!Array.isArray(parsed.steps)) throw new Error("the JSON needs a steps list");
        current = { steps: parsed.steps as Json[], exit_conditions: toConditionList(parsed.exit_conditions) };
        setPlan(current);
      } catch (err) {
        setProblems([err instanceof Error ? err.message : "invalid JSON"]);
        return;
      }
    }
    const p = stepProblems(current.steps);
    if (current.steps.length === 0) p.push("Add at least one step.");
    setProblems(p);
    if (p.length > 0) return;
    try {
      await onSave(planBody(current));
      setSaved(true);
    } catch (err) {
      setProblems(saveErrors(err));
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-[14px] text-muted-foreground">
          Every step field, written out. Saving stores these steps as the flow's plan.
        </p>
        <button
          type="button"
          className="shrink-0 text-[13px] text-accent-text hover:underline"
          onClick={() => setJson(json === null ? JSON.stringify(planBody(plan), null, 2) : null)}
        >
          {json === null ? "Edit as JSON" : "Back to the form"}
        </button>
      </div>

      {json !== null ? (
        <Textarea aria-label="Plan as JSON" className="min-h-96 font-mono text-[12px]" value={json} disabled={disabled} onChange={(e) => setJson(e.target.value)} />
      ) : (
        <>
          <ol className="space-y-3">
            {plan.steps.map((s, i) => (
              <StepCard
                key={i}
                step={s}
                disabled={disabled}
                onChange={(next) => setPlan({ ...plan, steps: plan.steps.map((x, j) => (j === i ? next : x)) })}
                onRemove={() => setPlan({ ...plan, steps: plan.steps.filter((_, j) => j !== i) })}
              />
            ))}
          </ol>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3"
            disabled={disabled}
            onClick={() => setPlan({ ...plan, steps: [...plan.steps, { order: nextOrder(plan.steps), action_type: "", delay: plan.steps.length === 0 ? "0m" : "1d", window_policy: "respect_window" }] })}
          >
            Add step
          </Button>
          <div className="mt-5">
            <ConditionListEditor
              label="The flow ends early if (any of these)"
              value={plan.exit_conditions}
              onChange={(l) => setPlan({ ...plan, exit_conditions: l })}
              scope="exit"
              anyOf
              disabled={disabled}
            />
          </div>
        </>
      )}

      {problems.length > 0 && (
        <div className="mt-4 rounded-md border border-danger bg-danger-soft px-4 py-3" role="alert">
          <ul className="list-disc space-y-0.5 pl-5 text-[14px] text-foreground">
            {problems.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
      )}
      <div className="mt-4 flex items-center gap-3">
        <Button type="button" onClick={() => void save()} disabled={saving || disabled}>
          {saving ? "Saving..." : "Save steps"}
        </Button>
        {saved && problems.length === 0 && <span className="text-[14px] text-muted-foreground" role="status">Saved.</span>}
      </div>
    </div>
  );
}
