/**
 * Trigger editor for the flow editor: every trigger type (lifecycle
 * transition, events, segment by grid cell or by lifecycle state, manual,
 * date property, date schedule) and the trigger's `where` conditions.
 */
import { useState } from "react";
import {
  ENGAGEMENT_DEPTHS,
  LIFECYCLE_STATES,
  defaultTriggerConfig,
  segmentByState,
  toConditionList,
  triggerEvents,
  type Json,
  type TriggerDraft,
  type TriggerType,
} from "../lib/flow-model.js";
import { ConditionListEditor } from "./condition-builder.js";
import { Input } from "./ui/input.js";
import { Select } from "./ui/select.js";
import { stateName, canonicalState } from "../lib/lifecycle-names.js";

export const TRIGGER_TYPE_OPTIONS: ReadonlyArray<{ value: TriggerType; label: string; description: string }> = [
  { value: "lifecycle_transition", label: "Lifecycle transition", description: "Starts when a contact moves between lifecycle states, e.g. engaged to at_risk." },
  { value: "event", label: "Event", description: "Starts when your app sends one of these events, e.g. plan_upgraded." },
  { value: "segment", label: "Segment", description: "Everyone in a lifecycle state or retention-grid cell now, and anyone who enters it later." },
  { value: "date_property", label: "Date", description: "A date trait is due, e.g. three days before trial_ends_at." },
  { value: "date_schedule", label: "Date schedule", description: "A series of sends anchored on a date trait, e.g. 1, 3 and 7 days after first payment." },
  { value: "manual", label: "Manual", description: "You enroll contacts (POST /v1/flows/:id/enroll), optionally filtered by conditions." },
];

const TENURE_BUCKET_OPTIONS = [
  { value: "new", label: "New (< 30 days)" },
  { value: "growing", label: "Growing (30-89 days)" },
  { value: "established", label: "Established (90-179 days)" },
  { value: "loyal", label: "Loyal (180+ days)" },
];

const RECENCY_BUCKET_OPTIONS = [
  { value: "active", label: "Active (inside the natural rhythm)" },
  { value: "cooling", label: "Cooling (1-2x the rhythm quiet)" },
  { value: "idle", label: "Idle (2-4x the rhythm quiet)" },
  { value: "dormant", label: "Dormant (4x+ the rhythm quiet)" },
];

const LABEL = "mb-1.5 block text-body font-medium text-foreground";
const HINT = "mt-1.5 text-small text-muted-foreground";

function CheckList({ options, selected, onChange, disabled, idPrefix, label = (o) => o }: { options: readonly string[]; selected: string[]; onChange: (v: string[]) => void; disabled?: boolean; idPrefix: string; label?: (o: string) => string }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {options.map((o) => (
        <label key={o} htmlFor={`${idPrefix}-${o}`} className="flex items-center gap-1.5 text-body text-foreground">
          <input
            id={`${idPrefix}-${o}`}
            type="checkbox"
            checked={selected.includes(o)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked ? [...selected, o] : selected.filter((x) => x !== o))}
            className="rounded border-input"
          />
          <span className="font-mono text-small">{label(o)}</span>
        </label>
      ))}
    </div>
  );
}

/** A comma-separated list input that keeps the text as typed. */
function ListInput({ id, value, onChange, placeholder, disabled }: { id: string; value: string[]; onChange: (v: string[]) => void; placeholder?: string; disabled?: boolean }) {
  const [text, setText] = useState(value.join(", "));
  return (
    <Input
      id={id}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      autoComplete="off"
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split(",").map((s) => s.trim()).filter((s) => s !== ""));
      }}
    />
  );
}

interface TriggerEditorProps {
  draft: TriggerDraft;
  onChange: (d: TriggerDraft) => void;
  disabled?: boolean;
  eventSuggestions?: string[];
  /** Show the type cards (new flows, or when changing the type). */
  showTypePicker?: boolean;
}

export function TriggerEditor({ draft, onChange, disabled, eventSuggestions = [], showTypePicker = true }: TriggerEditorProps) {
  const c = draft.config;
  const set = (patch: Json) => onChange({ type: draft.type, config: { ...c, ...patch } });
  const str = (k: string) => (typeof c[k] === "string" ? (c[k] as string) : "");

  return (
    <div className="space-y-4">
      {showTypePicker && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {TRIGGER_TYPE_OPTIONS.map((opt) => {
            const selected = draft.type === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                disabled={disabled}
                aria-pressed={selected}
                onClick={() => onChange({ type: opt.value, config: defaultTriggerConfig(opt.value) })}
                className={`rounded-lg border p-4 text-left transition-colors ${selected ? "border-accent bg-accent/5" : "border-border bg-card hover:border-border-strong"}`}
              >
                <p className="text-lead font-semibold text-foreground">{opt.label}</p>
                <p className="mt-1 text-body leading-relaxed text-muted-foreground">{opt.description}</p>
              </button>
            );
          })}
        </div>
      )}

      <div className="space-y-4 rounded-lg border border-border bg-card shadow-card p-5">
        {draft.type === "lifecycle_transition" && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="tc-from" className={LABEL}>From state (optional)</label>
              <Select id="tc-from" value={canonicalState(str("from"))} disabled={disabled} onChange={(e) => set({ from: e.target.value || undefined })}>
                <option value="">Any state</option>
                {LIFECYCLE_STATES.map((s) => <option key={s} value={s}>{stateName(s)}</option>)}
              </Select>
            </div>
            <div>
              <label htmlFor="tc-to" className={LABEL}>To state</label>
              <Select id="tc-to" value={canonicalState(str("to"))} disabled={disabled} onChange={(e) => set({ to: e.target.value })}>
                <option value="">Select state</option>
                {LIFECYCLE_STATES.map((s) => <option key={s} value={s}>{stateName(s)}</option>)}
              </Select>
            </div>
          </div>
        )}

        {draft.type === "event" && (
          <div>
            <label htmlFor="tc-event" className={LABEL}>Event names</label>
            <ListInput id="tc-event" value={triggerEvents(c)} onChange={(v) => set({ event: v })} placeholder="plan_upgraded, plan_downgraded" disabled={disabled} />
            <p className={HINT}>
              One or more, comma separated: any of them starts the flow.
              {eventSuggestions.length > 0 && <> Recently received: {eventSuggestions.slice(0, 12).join(", ")}.</>}
            </p>
          </div>
        )}

        {draft.type === "segment" && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-4 text-body text-foreground">
              <label className="flex items-center gap-1.5">
                <input type="radio" name="seg-mode" checked={segmentByState(c)} disabled={disabled} onChange={() => onChange({ type: "segment", config: { lifecycle_states: [], where: c.where } })} />
                By lifecycle state
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" name="seg-mode" checked={!segmentByState(c)} disabled={disabled} onChange={() => onChange({ type: "segment", config: { tenure_bucket: "", recency_bucket: "", where: c.where } })} />
                By retention-grid cell
              </label>
            </div>
            {segmentByState(c) ? (
              <>
                <div>
                  <p className={LABEL}>Lifecycle states</p>
                  <CheckList options={LIFECYCLE_STATES} selected={((c.lifecycle_states as string[]) ?? []).map(canonicalState)} onChange={(v) => set({ lifecycle_states: v })} disabled={disabled} idPrefix="seg-state" label={stateName} />
                </div>
                <div>
                  <p className={LABEL}>Engagement depth (optional)</p>
                  <CheckList options={ENGAGEMENT_DEPTHS} selected={(c.engagement_depths as string[]) ?? []} onChange={(v) => set({ engagement_depths: v })} disabled={disabled} idPrefix="seg-depth" />
                  <p className={HINT}>None checked: any depth.</p>
                </div>
              </>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="tc-tenure" className={LABEL}>Tenure</label>
                  <Select id="tc-tenure" value={str("tenure_bucket")} disabled={disabled} onChange={(e) => set({ tenure_bucket: e.target.value })}>
                    <option value="">Select tenure</option>
                    {TENURE_BUCKET_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                </div>
                <div>
                  <label htmlFor="tc-recency" className={LABEL}>Recency</label>
                  <Select id="tc-recency" value={str("recency_bucket")} disabled={disabled} onChange={(e) => set({ recency_bucket: e.target.value })}>
                    <option value="">Select recency</option>
                    {RECENCY_BUCKET_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                </div>
              </div>
            )}
            <p className={HINT}>Matching contacts enroll on the next scan, and whenever they match again later (re-entry rules apply).</p>
          </div>
        )}

        {draft.type === "manual" && (
          <p className="text-body text-muted-foreground">
            Contacts enter when you enroll them through the API. The conditions below filter who may enter.
          </p>
        )}

        {draft.type === "date_property" && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="tc-prop" className={LABEL}>Date trait</label>
              <Input id="tc-prop" value={str("property")} placeholder="trial_ends_at" disabled={disabled} onChange={(e) => set({ property: e.target.value })} />
            </div>
            <div>
              <label htmlFor="tc-offset" className={LABEL}>Offset</label>
              <Input id="tc-offset" value={str("offset")} placeholder="-3d" disabled={disabled} onChange={(e) => set({ offset: e.target.value })} />
            </div>
            <div>
              <label htmlFor="tc-local" className={LABEL}>Local send time (optional)</label>
              <Input id="tc-local" value={str("send_at_local")} placeholder="09:00" disabled={disabled} onChange={(e) => set({ send_at_local: e.target.value || undefined })} />
            </div>
            <p className={`${HINT} sm:col-span-3`}>
              The trait must be listed in settings.date_traits. A negative offset is before the date.
            </p>
          </div>
        )}

        {draft.type === "date_schedule" && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="tc-anchor" className={LABEL}>Anchor date trait</label>
              <Input id="tc-anchor" value={str("anchor")} placeholder="first_paid_at" disabled={disabled} onChange={(e) => set({ anchor: e.target.value })} />
            </div>
            <div>
              <label htmlFor="tc-offsets" className={LABEL}>Offsets</label>
              <ListInput id="tc-offsets" value={Array.isArray(c.offsets) ? (c.offsets as string[]) : []} onChange={(v) => set({ offsets: v })} placeholder="1d, 3d, 7d, 14d, 30d" disabled={disabled} />
            </div>
            <div>
              <label htmlFor="tc-repeat" className={LABEL}>Then repeat every (optional)</label>
              <Input id="tc-repeat" value={str("repeat")} placeholder="30d" disabled={disabled} onChange={(e) => set({ repeat: e.target.value || undefined })} />
            </div>
            <div>
              <label htmlFor="tc-max" className={LABEL}>Maximum sends</label>
              <Input id="tc-max" type="number" min={1} value={typeof c.max_sends === "number" ? String(c.max_sends) : ""} disabled={disabled} onChange={(e) => set({ max_sends: e.target.value === "" ? undefined : Number(e.target.value) })} />
            </div>
            <div>
              <label htmlFor="tc-local" className={LABEL}>Local send time (optional)</label>
              <Input id="tc-local" value={str("send_at_local")} placeholder="09:30" disabled={disabled} onChange={(e) => set({ send_at_local: e.target.value || undefined })} />
            </div>
            <p className={`${HINT} sm:col-span-2`}>
              For a long schedule, use the Scheduled flow class so it runs alongside nurture flows.
            </p>
          </div>
        )}

        <ConditionListEditor
          label="Only when (optional)"
          hint="Every condition must hold when the contact would enter."
          value={toConditionList(c.where)}
          onChange={(list) => set({ where: list })}
          scope="contact"
          disabled={disabled}
        />
      </div>
    </div>
  );
}
