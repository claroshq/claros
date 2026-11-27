/**
 * The non-email nodes of the timeline: what starts the flow, what ends it
 * early, the prompt of a prompt-defined flow, and the delivery settings tab.
 */
import { Link } from "react-router-dom";
import type { Flow, LayoutSummary, Topic } from "../../api.js";
import type { Condition, TriggerDraft } from "../../lib/flow-model.js";
import type { EditorDraft, FlowSettingsDraft } from "../../lib/flow-editor-model.js";
import { ConditionListEditor } from "../condition-builder.js";
import { TriggerEditor } from "../trigger-editor.js";
import { Badge, type BadgeVariant } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { Select } from "../ui/select.js";
import { Textarea } from "../ui/textarea.js";

const HINT = "mt-1.5 text-[13px] leading-relaxed text-muted-foreground";

function PanelHead({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-[19px] font-semibold text-foreground">{title}</h2>
      <p className="mt-0.5 text-[14px] text-muted-foreground">{sub}</p>
    </div>
  );
}

export function TriggerPanel({
  trigger,
  onChange,
  eventNames,
  dateTraits,
  disabled,
  isNew,
  problems,
}: {
  trigger: TriggerDraft;
  onChange: (t: TriggerDraft) => void;
  eventNames: string[];
  dateTraits: string[];
  disabled: boolean;
  isNew: boolean;
  problems: string[];
}) {
  const isDate = trigger.type === "date_property" || trigger.type === "date_schedule";
  return (
    <div>
      <PanelHead
        title="Who enters this flow"
        sub={isNew ? "Pick what starts the flow, then narrow it down with conditions." : "Changing the trigger affects who enters from now on; contacts already in the flow stay."}
      />
      <TriggerEditor draft={trigger} onChange={onChange} disabled={disabled} eventSuggestions={eventNames} />
      {isDate && (
        <p className={HINT}>
          {dateTraits.length > 0
            ? `Date traits this product declares: ${dateTraits.join(", ")}.`
            : "This product declares no date traits yet. List them in settings.date_traits (Settings, Config as code) before a date trigger can fire."}
        </p>
      )}
      {problems.length > 0 && (
        <ul className="mt-4 list-disc pl-5 text-[13px] text-danger" role="alert">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
    </div>
  );
}

export function ExitsPanel({
  exits,
  onChange,
  eventNames,
  disabled,
}: {
  exits: Condition[];
  onChange: (c: Condition[]) => void;
  eventNames: string[];
  disabled: boolean;
}) {
  const suggestions: Array<{ label: string; cond: Condition }> = [
    ...eventNames.slice(0, 4).map((e) => ({ label: `event ${e} arrives`, cond: { event: e } as Condition })),
    { label: "they go quiet", cond: { lifecycle_state_change: { to: "churned" } } },
    { label: "they become engaged", cond: { lifecycle_state_change: { to: "engaged" } } },
  ].filter((s) => !exits.some((x) => JSON.stringify(x) === JSON.stringify(s.cond)));
  return (
    <div>
      <PanelHead title="When the flow stops early" sub="A contact leaves as soon as any of these is true, and the emails not yet sent are cancelled. Without one, the flow ends after the last email." />
      <ConditionListEditor label="Stop when any of these is true" value={exits} onChange={onChange} scope="exit" anyOf disabled={disabled} />
      {!disabled && suggestions.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[13px] text-muted-foreground">Add a common one:</span>
          {suggestions.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => onChange([...exits, s.cond])}
              className="rounded-md border border-border bg-card px-2 py-0.5 text-[13px] text-foreground hover:border-border-strong"
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      <p className={HINT}>Typical: stop an upgrade nudge when the subscription starts, stop dunning when the payment succeeds.</p>
    </div>
  );
}

function compileBadge(cs: Flow["compile_status"]): { variant: BadgeVariant; label: string } {
  switch (cs) {
    case "pending": return { variant: "warning", label: "compiling" };
    case "ready": return { variant: "success", label: "compiled" };
    case "failed": return { variant: "danger", label: "compile failed" };
    default: return { variant: "muted", label: "not compiled" };
  }
}

export function PromptPanel({
  prompt,
  onChange,
  flow,
  promptDirty,
  locked,
  disabled,
  hasLlm,
  compiling,
  compileError,
  onCompile,
}: {
  prompt: string;
  onChange: (v: string) => void;
  flow: Flow | undefined;
  promptDirty: boolean;
  locked: boolean;
  disabled: boolean;
  hasLlm: boolean;
  compiling: boolean;
  compileError: string | null;
  onCompile: () => void;
}) {
  const badge = compileBadge(flow?.compile_status ?? null);
  return (
    <div>
      <PanelHead title="The prompt" sub="Describe the flow in your own words. Compiling turns it into the emails on the left, which you can then read and adjust." />
      {locked && (
        <p className="mb-3 rounded-md border border-border bg-secondary px-3 py-2 text-[14px] text-muted-foreground" role="note">
          The prompt is locked while the flow is active. Pause the flow to change it. The emails themselves stay editable.
        </p>
      )}
      <Textarea
        aria-label="Prompt"
        value={prompt}
        rows={8}
        className="text-[15px] leading-relaxed"
        disabled={disabled || locked}
        onChange={(e) => onChange(e.target.value)}
        placeholder="When someone signs up on the free plan, welcome them right away. If they have not created a project after a day, show them the two-minute setup. Two days later, send one tip. Stop as soon as they upgrade."
      />
      <p className={HINT}>A good prompt names who enters, each email and when it goes, when to skip one, and when to stop.</p>
      {flow && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="button" size="sm" variant="outline" disabled={disabled || compiling || promptDirty || !hasLlm || !flow.prompt_source} onClick={onCompile}>
            {compiling ? "Compiling..." : flow.compile_status === "ready" ? "Compile again" : "Compile"}
          </Button>
          <Badge variant={badge.variant} pulse={flow.compile_status === "pending"}>{badge.label}</Badge>
          <span className="text-[13px] text-muted-foreground">
            {!hasLlm ? "Compiling needs an LLM provider (Settings, LLM)." : promptDirty ? "Save the prompt first, then compile." : "Compiling replaces the emails with the ones the prompt describes."}
          </span>
        </div>
      )}
      {flow?.compile_status === "failed" && flow.compile_error && (
        <p className="mt-3 whitespace-pre-wrap break-words rounded-md border border-danger bg-danger-soft px-3 py-2 font-mono text-[13px] text-foreground" role="alert">
          {flow.compile_error}
        </p>
      )}
      {compileError && <p className="mt-3 rounded-md border border-danger bg-danger-soft px-3 py-2 text-[14px] text-foreground" role="alert">{compileError}</p>}
    </div>
  );
}

function Choice({ name, checked, onChange, title, children, disabled }: { name: string; checked: boolean; onChange: () => void; title: React.ReactNode; children?: React.ReactNode; disabled: boolean }) {
  return (
    <label className={`mt-2 flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-3 transition-colors ${checked ? "border-accent bg-accent-soft/50" : "border-border hover:border-border-strong"} ${disabled ? "cursor-not-allowed opacity-70" : ""}`}>
      <input type="radio" name={name} className="mt-1" checked={checked} disabled={disabled} onChange={onChange} />
      <span className="min-w-0">
        <span className="block text-[15px] font-semibold text-foreground">{title}</span>
        {children && <span className="block text-[13px] leading-relaxed text-muted-foreground">{children}</span>}
      </span>
    </label>
  );
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border pt-5 first:border-t-0 first:pt-0">
      <h3 className="text-[15px] font-semibold text-foreground">{title}</h3>
      <div className="mt-1">{children}</div>
    </section>
  );
}

export function DeliverySettings({
  draft,
  onChange,
  topics,
  templates,
  disabled,
  flow,
}: {
  draft: EditorDraft;
  onChange: (patch: Partial<FlowSettingsDraft>) => void;
  topics: Topic[];
  /** The product's email templates; null while loading or on older servers. */
  templates: { active: string; templates: LayoutSummary[] } | null;
  disabled: boolean;
  flow: Flow | undefined;
}) {
  const d = disabled;
  const sendable = topics.filter((t) => !t.mirror_only);
  return (
    <div className="max-w-3xl space-y-6 rounded-xl border border-border bg-card p-6">
      <SettingsSection title="Review before sending">
        <Choice name="approval" disabled={d} checked={draft.approval_mode === "require"} onChange={() => onChange({ approval_mode: "require" })} title="I approve each email">
          Every message waits in Approvals until someone approves it. Recommended while a flow is new, and for AI-drafted mail.
        </Choice>
        <Choice name="approval" disabled={d} checked={draft.approval_mode === "auto"} onChange={() => onChange({ approval_mode: "auto" })} title="Send without review">
          For copy you trust. AI drafts can still get a fact or the tone wrong; what goes out is your responsibility.
        </Choice>
      </SettingsSection>

      {sendable.length > 0 && (
        <SettingsSection title="Topic">
          <Select aria-label="Topic" className="mt-2 max-w-sm" value={draft.topic_id ?? ""} disabled={d} onChange={(e) => onChange({ topic_id: e.target.value || null })}>
            <option value="">No topic</option>
            {sendable.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.kind})</option>)}
          </Select>
          <p className={HINT}>Contacts unsubscribed from the topic get none of this flow&apos;s mail. Transactional topics carry no List-Unsubscribe header.</p>
        </SettingsSection>
      )}

      {templates && (
        <SettingsSection title="Email template">
          <Select
            aria-label="Email template"
            className="mt-2 max-w-sm"
            value={draft.email_template ?? ""}
            disabled={d}
            onChange={(e) => onChange({ email_template: e.target.value || null })}
          >
            <option value="">Product default ({templates.templates.find((t) => t.ref === templates.active)?.name ?? templates.active})</option>
            {templates.templates.map((t) => (
              <option key={t.ref} value={t.ref}>
                {t.name} ({t.width}{t.kind === "custom" ? ", custom" : ""})
              </option>
            ))}
            {draft.email_template && !templates.templates.some((t) => t.ref === draft.email_template) && (
              <option value={draft.email_template}>Deleted template (sends with the product default)</option>
            )}
          </Select>
          <p className={HINT}>
            The design this flow&apos;s emails are sent in. Edit templates on the <Link to="/templates" className="text-accent-text underline">Templates</Link> page.
          </p>
        </SettingsSection>
      )}

      <SettingsSection title="Running alongside other flows">
        <Choice name="class" disabled={d} checked={draft.flow_class === "nurture"} onChange={() => onChange({ flow_class: "nurture" })} title="One at a time (nurture)">
          A contact is in at most one nurture flow; a higher-priority one takes the slot. Respects frequency caps and the send window. Onboarding, tips, win-back.
        </Choice>
        <Choice name="class" disabled={d} checked={draft.flow_class === "scheduled"} onChange={() => onChange({ flow_class: "scheduled" })} title="Alongside others (scheduled)">
          Long date schedules such as a monthly nudge. Never takes the nurture slot; still respects caps and the send window.
        </Choice>
        <Choice name="class" disabled={d} checked={draft.flow_class === "critical"} onChange={() => onChange({ flow_class: "critical" })} title="Always (critical)">
          Billing and security mail. Runs alongside everything and ignores frequency caps.
        </Choice>
        {draft.flow_class === "nurture" && (
          <div className="mt-4">
            <label htmlFor="flow-priority" className="block text-[14px] font-medium text-foreground">Priority among nurture flows</label>
            <div className="mt-1.5 flex flex-wrap items-center gap-3">
              <Input id="flow-priority" type="number" className="w-24" value={String(draft.priority)} disabled={d} onChange={(e) => onChange({ priority: Number.isInteger(Number(e.target.value)) ? Number(e.target.value) : draft.priority })} />
              <span className="text-[13px] text-muted-foreground">When two nurture flows want the same contact, the higher number wins.</span>
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Can a contact go through it again?">
        {(draft.trigger.type === "date_property" || draft.trigger.type === "date_schedule") && (
          <p className="mt-1 text-[13px] text-muted-foreground">Date flows enroll once per date value; this setting does not apply to them.</p>
        )}
        <Choice name="reentry" disabled={d} checked={draft.reentry_policy === "once"} onChange={() => onChange({ reentry_policy: "once" })} title="Only once">
          Right for welcome and onboarding.
        </Choice>
        <Choice
          name="reentry"
          disabled={d}
          checked={draft.reentry_policy === "cooldown"}
          onChange={() => onChange({ reentry_policy: "cooldown" })}
          title={
            <span className="flex flex-wrap items-center gap-2">
              Again after
              <Input
                aria-label="Cooldown in days"
                type="number"
                min={1}
                className="h-8 w-20"
                value={String(draft.reentry_cooldown_days)}
                disabled={d}
                onChange={(e) => onChange({ reentry_policy: "cooldown", reentry_cooldown_days: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
              />
              days
            </span>
          }
        >
          Win-back and upgrade nudges.
        </Choice>
        <Choice name="reentry" disabled={d} checked={draft.reentry_policy === "every_time"} onChange={() => onChange({ reentry_policy: "every_time" })} title="Every time the trigger fires">
          Receipts, payment problems.
        </Choice>
      </SettingsSection>

      {flow && (
        <p className="border-t border-border pt-5 text-[13px] text-muted-foreground">
          ID <code className="font-mono text-[12px]">{flow.id}</code>
          {flow.slug && <> · config slug <code className="font-mono text-[12px]">{flow.slug}</code></>} · created {new Date(flow.created_at).toLocaleDateString()} · updated {new Date(flow.updated_at).toLocaleString()}
        </p>
      )}
    </div>
  );
}
