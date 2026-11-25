/**
 * Step field editors shared by the flow editor's step panel: allowed links,
 * context sources, knowledge base selection and the candidates of a choose
 * step. Values keep the config document shape (docs/guide/FLOWS.md).
 */
import React, { useState } from "react";
import { toConditionList, type Json } from "../lib/flow-model.js";
import { ConditionListEditor } from "./condition-builder.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Select } from "./ui/select.js";
import { Textarea } from "./ui/textarea.js";

const LABEL = "mb-1 block text-[13px] font-medium text-foreground";
const HINT = "mt-1 text-[12px] text-muted-foreground";

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
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
export function NamesInput({ value, onChange, placeholder, disabled, label }: { value: unknown; onChange: (v: string[] | undefined) => void; placeholder?: string; disabled?: boolean; label: string }) {
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

export function ContextList({ value, onChange, disabled, sources = [] }: { value: unknown; onChange: (v: Json[] | undefined) => void; disabled?: boolean; sources?: string[] }) {
  const items = Array.isArray(value) ? (value as Json[]) : [];
  const set = (next: Json[]) => onChange(next.length > 0 ? next : undefined);
  const listId = React.useId();
  return (
    <div className="space-y-2">
      <datalist id={listId}>{sources.map((s) => <option key={s} value={s} />)}</datalist>
      {items.map((c, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input aria-label="Data source" list={listId} className="h-8 w-36 text-[13px]" placeholder="source" value={text(c.source)} disabled={disabled} onChange={(e) => set(items.map((x, j) => (j === i ? { ...x, source: e.target.value } : x)))} />
          <Input aria-label="Mode" className="h-8 w-32 text-[13px]" placeholder="mode" value={text(c.mode)} disabled={disabled} onChange={(e) => set(items.map((x, j) => (j === i ? { ...x, mode: e.target.value || undefined } : x)))} />
          <Input aria-label="Limit" type="number" min={1} max={100} className="h-8 w-24 text-[13px]" placeholder="limit" value={text(c.limit)} disabled={disabled} onChange={(e) => set(items.map((x, j) => (j === i ? { ...x, limit: e.target.value === "" ? undefined : Number(e.target.value) } : x)))} />
          <Button type="button" size="sm" variant="ghost" className="h-8" disabled={disabled} onClick={() => set(items.filter((_, j) => j !== i))}>Remove</Button>
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" className="h-8" disabled={disabled || items.length >= 5} onClick={() => set([...items, { source: "" }])}>Add context source</Button>
    </div>
  );
}

export function KbSelectFields({ value, onChange, disabled, categories = [] }: { value: unknown; onChange: (v: Json | undefined) => void; disabled?: boolean; categories?: string[] }) {
  const kb = value && typeof value === "object" ? (value as Json) : null;
  const listId = React.useId();
  if (!kb) {
    return <Button type="button" size="sm" variant="outline" className="h-8" disabled={disabled} onClick={() => onChange({ category: "" })}>Pick a knowledge base entry</Button>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <datalist id={listId}>{categories.map((c) => <option key={c} value={c} />)}</datalist>
      <Input aria-label="KB category" list={listId} className="h-8 w-36 text-[13px]" placeholder="category" value={text(kb.category)} disabled={disabled} onChange={(e) => onChange({ ...kb, category: e.target.value })} />
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

export function CandidateCard({ value, onChange, onRemove, disabled }: { value: Json; onChange: (c: Json) => void; onRemove: () => void; disabled?: boolean }) {
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
