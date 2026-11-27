/**
 * Editor for one email of the flow: who writes it (fixed copy or the AI),
 * the copy or the instruction with examples, a live preview, timing, the
 * condition that skips it, and the rarer fields under Advanced. Every
 * change goes into the page's draft; nothing saves from here.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import type { StepCopy } from "../../api.js";
import { draftFlowStep } from "../../api.js";
import { toConditionList, type Json } from "../../lib/flow-model.js";
import {
  describeDelay,
  formatDelay,
  parseDelay,
  stepMode,
  unknownVariables,
  variablesWithoutFallback,
  type DelayUnit,
} from "../../lib/flow-editor-model.js";
import { INSTRUCTION_EXAMPLES } from "../../lib/flow-recipes.js";
import { ConditionListEditor } from "../condition-builder.js";
import { CandidateCard, ContextList, KbSelectFields } from "../step-fields.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { Select } from "../ui/select.js";
import { Textarea } from "../ui/textarea.js";
import { HtmlCodeEditor, type CodeEditorHandle } from "../code-editor/index.js";
import { EmailPreview, type PreviewSample } from "./email-preview.js";

export interface EditorEnv {
  flowId?: string;
  /** Flow saved and this step saved as it is (AI draft needs the stored plan). */
  canDraftWithAi: boolean;
  hasLlm: boolean;
  links: Array<{ name: string; url: string }>;
  dataSources: string[];
  kbCategories: string[];
  sample: PreviewSample;
  disabled: boolean;
}

const LABEL = "mb-1.5 block text-[16px] font-medium text-foreground";
const HINT = "mt-1.5 text-[15px] leading-relaxed text-muted-foreground";

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border pt-5">
      <h3 className="text-[17px] font-semibold text-foreground">{title}</h3>
      {hint && <p className="mt-0.5 text-[15px] text-muted-foreground">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Segmented({ value, options, onChange, disabled, label }: { value: string; options: Array<{ value: string; label: string; disabled?: boolean; title?: string }>; onChange: (v: string) => void; disabled?: boolean; label?: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap gap-0.5 rounded-lg border border-border bg-sunken p-[3px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          disabled={disabled || o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1.5 text-[16px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${value === o.value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Chip({ children, onClick, disabled, title, mono }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; title?: string; mono?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`rounded-md border border-border bg-card px-2 py-0.5 text-[15px] text-foreground transition-colors hover:border-border-strong disabled:opacity-50 ${mono ? "font-mono text-[14px]" : ""}`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Fixed copy
// ---------------------------------------------------------------------------

type EmailView = "split" | "code" | "preview";
const VIEW_KEY = "claros.flowEditor.emailView";

/** Code, preview or both; the choice is kept per browser. */
function useEmailView(): [EmailView, (v: EmailView) => void] {
  const [view, setView] = useState<EmailView>(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      return v === "code" || v === "preview" ? v : "split";
    } catch {
      return "split";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
  }, [view]);
  return [view, setView];
}

function FixedCopyEditor({
  step,
  copy,
  onStep,
  onCopy,
  env,
  sharedWith,
  stepIndex,
}: {
  step: Json;
  copy: StepCopy;
  onStep: (patch: Json) => void;
  onCopy: (c: StepCopy) => void;
  env: EditorEnv;
  sharedWith: number;
  stepIndex: number;
}) {
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<CodeEditorHandle>(null);
  const [view, setView] = useEmailView();
  const lastField = useRef<"subject" | "body">("body");
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const d = env.disabled;

  function insert(token: string) {
    if (lastField.current === "body" && bodyRef.current) {
      bodyRef.current.insert(token);
      return;
    }
    const el = subjectRef.current;
    const current = copy.subject;
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    onCopy({ ...copy, subject: current.slice(0, start) + token + current.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function draftWithAi() {
    if (!env.flowId) return;
    setDrafting(true);
    setDraftError(null);
    try {
      const r = await draftFlowStep(env.flowId, { step_order: Number(step.order), subject: copy.subject || undefined, body_html: copy.body_html || undefined });
      onCopy({ ...copy, subject: r.subject, body_html: r.body_html });
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : "The AI draft failed.");
    } finally {
      setDrafting(false);
    }
  }

  const text = `${copy.subject}\n${copy.body_html}`;
  const unknown = unknownVariables(text);
  const noFallback = variablesWithoutFallback(text);

  const preheader = typeof step.preheader === "string" ? step.preheader : undefined;

  return (
    <div className="@container space-y-4">
      {sharedWith > 0 && (
        <p className="rounded-md border border-warning bg-warning-soft px-3 py-2 text-[15px] text-foreground" role="note">
          This copy is also used by {sharedWith === 1 ? "another flow" : `${sharedWith} other flows`}. Changing it here changes it there too.
        </p>
      )}
      <div className="flex justify-end">
        <Segmented
          label="Email view"
          value={view}
          onChange={(v) => setView(v as EmailView)}
          options={[
            { value: "code", label: "Code", title: "Edit the email without the preview" },
            { value: "preview", label: "Preview", title: "The email as a sample contact sees it" },
            { value: "split", label: "Both", title: "Code and a live preview together: side by side when there is room, else stacked" },
          ]}
        />
      </div>
      <div className={view === "split" ? "grid grid-cols-1 gap-6 @3xl:grid-cols-2" : ""}>
      {view !== "preview" && (
      <div className="min-w-0 space-y-4">
        <div>
          <label htmlFor={`subject-${stepIndex}`} className={LABEL}>Subject</label>
          <Input
            id={`subject-${stepIndex}`}
            ref={subjectRef}
            value={copy.subject}
            disabled={d}
            onFocus={() => (lastField.current = "subject")}
            onChange={(e) => onCopy({ ...copy, subject: e.target.value })}
            placeholder="Welcome to {{tenant.name}}, {{contact.first_name|there}}"
          />
        </div>
        <div>
          <label htmlFor={`preheader-${stepIndex}`} className={LABEL}>
            Preview text <span className="font-normal text-muted-foreground">(optional, shown after the subject in the inbox)</span>
          </label>
          <Input
            id={`preheader-${stepIndex}`}
            value={typeof step.preheader === "string" ? step.preheader : ""}
            maxLength={200}
            disabled={d}
            onChange={(e) => onStep({ preheader: e.target.value || undefined })}
            placeholder="Your account is ready"
          />
        </div>
        <div>
          <label htmlFor={`body-${stepIndex}`} className={LABEL}>Body</label>
          <HtmlCodeEditor
            id={`body-${stepIndex}`}
            ariaLabel="Body (HTML)"
            ref={bodyRef}
            value={copy.body_html}
            disabled={d}
            onFocus={() => (lastField.current = "body")}
            onChange={(v) => onCopy({ ...copy, body_html: v })}
            placeholder={"<p>Hi {{contact.first_name|there}},</p>\n<p>One short paragraph on why this email exists.</p>\n<p>One clear next step.</p>"}
          />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[15px] text-muted-foreground">Insert:</span>
            <Chip disabled={d} onClick={() => insert("{{contact.first_name|there}}")} title="{{contact.first_name|there}}">first name</Chip>
            <Chip disabled={d} onClick={() => insert("{{tenant.name}}")} title="{{tenant.name}}">product name</Chip>
            <Chip disabled={d} onClick={() => insert("{{traits.plan|}}")} title="Any trait you send with identify: {{traits.<key>|fallback}}">a trait</Chip>
            <Chip disabled={d} onClick={() => insert("<p></p>")}>paragraph</Chip>
            {env.links.map((l) => (
              <Chip key={l.name} disabled={d} mono onClick={() => insert(`<a href="{{links.${l.name}}}">Open</a>`)} title={l.url}>
                link: {l.name}
              </Chip>
            ))}
          </div>
          <p className={HINT}>
            HTML. <code className="font-mono text-[14px]">{"{{contact.first_name|there}}"}</code> uses &quot;there&quot; when a contact has no first name.
            {env.links.length === 0 && <> Named links (Settings, Config as code: <code className="font-mono text-[14px]">settings.links</code>) appear here as insert buttons.</>}
          </p>
        </div>
        {unknown.length > 0 && (
          <p className="rounded-md border border-danger bg-danger-soft px-3 py-2 text-[15px] text-foreground" role="alert">
            Claros does not know {unknown.map((v) => `{{${v}}}`).join(", ")}, so this email would fail to render. Use contact.first_name, contact.last_name, contact.email, tenant.name, traits.&lt;key&gt;, links.&lt;name&gt; or event.&lt;key&gt;.
          </p>
        )}
        {unknown.length === 0 && noFallback.length > 0 && (
          <p className="text-[15px] text-muted-foreground" role="note">
            No fallback for {noFallback.map((v) => `{{${v}}}`).join(", ")}: a contact without that value does not get this email. Add one with <code className="font-mono text-[14px]">|</code>, as in <code className="font-mono text-[14px]">{"{{contact.first_name|there}}"}</code>.
          </p>
        )}
        <details className="group">
          <summary className="cursor-pointer text-[15px] font-medium text-accent-text">Plain-text version (optional)</summary>
          <Textarea
            aria-label="Plain-text body"
            className="mt-2 text-[16px]"
            rows={6}
            value={copy.body_text ?? ""}
            disabled={d}
            onChange={(e) => onCopy({ ...copy, body_text: e.target.value === "" ? null : e.target.value })}
            placeholder="Left empty, Claros derives it from the HTML."
          />
        </details>
        {env.hasLlm && (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" variant="outline" disabled={d || drafting || !env.canDraftWithAi} onClick={() => void draftWithAi()}>
              {drafting ? "Drafting..." : copy.body_html.trim() ? "Improve with AI" : "Draft with AI"}
            </Button>
            <span className="text-[15px] text-muted-foreground">
              {env.canDraftWithAi ? "Fills the subject and body for you to edit. Nothing is saved until you save." : "Save the flow first; the AI drafts from the saved sequence."}
            </span>
          </div>
        )}
        {draftError && <p className="text-[15px] text-danger" role="alert">{draftError}</p>}
      </div>
      )}
      {view !== "code" && (
        <div className={`min-w-0 ${view === "split" ? "@3xl:sticky @3xl:top-4 @3xl:self-start" : ""}`}>
          <EmailPreview subject={copy.subject} preheader={preheader} bodyHtml={copy.body_html} sample={env.sample} height={view === "preview" ? 640 : 460} />
        </div>
      )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI-drafted
// ---------------------------------------------------------------------------

function LinkPicker({ value, onChange, links, disabled }: { value: unknown; onChange: (v: string[] | undefined) => void; links: EditorEnv["links"]; disabled: boolean }) {
  const selected = Array.isArray(value) ? (value as string[]) : [];
  if (links.length === 0) {
    return <p className="text-[15px] text-muted-foreground">No named links yet. Add them under <code className="font-mono text-[14px]">settings.links</code> in your config document so the AI can link to real pages.</p>;
  }
  return (
    <div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {links.map((l) => (
          <label key={l.name} className="flex items-center gap-1.5 text-[16px] text-foreground" title={l.url}>
            <input
              type="checkbox"
              checked={selected.includes(l.name)}
              disabled={disabled}
              onChange={(e) => {
                const next = e.target.checked ? [...selected, l.name] : selected.filter((x) => x !== l.name);
                onChange(next.length > 0 ? next : undefined);
              }}
            />
            <span className="font-mono text-[14px]">{l.name}</span>
          </label>
        ))}
      </div>
      <p className={HINT}>None checked: any named link. A draft with a URL outside your named links is blocked.</p>
    </div>
  );
}

function AiEditor({ step, onStep, env, stepIndex }: { step: Json; onStep: (patch: Json) => void; env: EditorEnv; stepIndex: number }) {
  const d = env.disabled;
  const instruction = typeof step.brain_instruction === "string" ? step.brain_instruction : "";
  const hasContext = Array.isArray(step.context) && step.context.length > 0;
  return (
    <div className="space-y-4">
      {!env.hasLlm && (
        <p className="rounded-md border border-warning bg-warning-soft px-3 py-2 text-[15px] text-foreground" role="note">
          No LLM provider is configured for this product, so this email cannot be drafted. Add one in Settings, LLM, or switch to &quot;I write it&quot;.
        </p>
      )}
      <div>
        <label htmlFor={`instr-${stepIndex}`} className={LABEL}>What should this email do?</label>
        <Textarea
          id={`instr-${stepIndex}`}
          value={instruction}
          disabled={d}
          rows={6}
          className="text-[17px] leading-relaxed"
          onChange={(e) => onStep({ brain_instruction: e.target.value })}
          placeholder="Who is this person at this moment, the one thing you want them to do, and the tone. For example: They signed up yesterday and have not created a project. Name the one step to a first result and link to setup. Three short paragraphs, no feature list."
        />
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[15px] text-muted-foreground">Start from an example:</span>
          {INSTRUCTION_EXAMPLES.map((ex) => (
            <Chip key={ex.label} disabled={d} title={ex.text} onClick={() => onStep({ brain_instruction: ex.text })}>
              {ex.label}
            </Chip>
          ))}
        </div>
        <p className={HINT}>
          The AI writes a separate draft for each contact from this instruction, their traits and recent events, and your knowledge base. Variables work here too, for example <code className="font-mono text-[14px]">{"{{traits.plan}}"}</code>.
        </p>
      </div>
      <div className="space-y-4 rounded-lg border border-border bg-sunken p-4">
        <p className="text-[16px] font-semibold text-foreground">What the AI may use</p>
        <div>
          <p className={LABEL}>Links</p>
          <LinkPicker value={step.allowed_links} onChange={(v) => onStep({ allowed_links: v })} links={env.links} disabled={d} />
          <label className="mt-2 flex items-center gap-2 text-[16px] text-foreground">
            <input type="checkbox" checked={step.single_cta === true} disabled={d} onChange={(e) => onStep({ single_cta: e.target.checked ? true : undefined })} />
            At most one link (footer and unsubscribe aside)
          </label>
        </div>
        <div>
          <p className={LABEL}>Knowledge base entry</p>
          <KbSelectFields value={step.kb_select} onChange={(v) => onStep({ kb_select: v })} disabled={d} categories={env.kbCategories} />
          <p className={HINT}>Picks one entry of a category per email, for example a tip the contact has not seen yet.</p>
        </div>
        <div>
          <p className={LABEL}>Data from your app</p>
          <ContextList value={step.context} onChange={(v) => onStep({ context: v })} disabled={d} sources={env.dataSources} />
          <p className={HINT}>
            {env.dataSources.length > 0 ? `Sources: ${env.dataSources.join(", ")}.` : "Context sources are declared in settings.data_sources."} Fetched when the email is written.
          </p>
          {hasContext && (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className={LABEL} htmlFor={`onempty-${stepIndex}`}>When the source returns nothing</label>
                <Select id={`onempty-${stepIndex}`} value={typeof step.on_empty === "string" ? step.on_empty : "send"} disabled={d} onChange={(e) => onStep({ on_empty: e.target.value })}>
                  <option value="send">Send anyway</option>
                  <option value="skip">Skip this email</option>
                </Select>
              </div>
              <div>
                <label className={LABEL} htmlFor={`onerror-${stepIndex}`}>When the source fails</label>
                <Select id={`onerror-${stepIndex}`} value={typeof step.on_error === "string" ? step.on_error : "defer"} disabled={d} onChange={(e) => onStep({ on_error: e.target.value })}>
                  <option value="defer">Retry later</option>
                  <option value="skip">Skip this email</option>
                  <option value="fail">Mark the email failed</option>
                </Select>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChooseEditor({ step, onStep, env, stepIndex }: { step: Json; onStep: (patch: Json) => void; env: EditorEnv; stepIndex: number }) {
  const d = env.disabled;
  const candidates = Array.isArray(step.candidates) ? (step.candidates as Json[]) : [];
  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={`instr-${stepIndex}`} className={LABEL}>How should the AI choose?</label>
        <Textarea id={`instr-${stepIndex}`} rows={5} value={typeof step.brain_instruction === "string" ? step.brain_instruction : ""} disabled={d} onChange={(e) => onStep({ brain_instruction: e.target.value || undefined })} />
        <p className={HINT}>Only the candidates whose conditions hold are offered; the AI picks one{step.allow_none === false ? "" : " or none"}.</p>
      </div>
      <label className="flex items-center gap-2 text-[16px] text-foreground">
        <input type="checkbox" checked={step.allow_none !== false} disabled={d} onChange={(e) => onStep({ allow_none: e.target.checked ? undefined : false })} />
        The AI may decide to send nothing
      </label>
      {candidates.map((c, i) => (
        <CandidateCard
          key={i}
          value={c}
          disabled={d}
          onChange={(next) => onStep({ candidates: candidates.map((x, j) => (j === i ? next : x)) })}
          onRemove={() => onStep({ candidates: candidates.filter((_, j) => j !== i) })}
        />
      ))}
      <Button type="button" size="sm" variant="outline" disabled={d || candidates.length >= 20} onClick={() => onStep({ candidates: [...candidates, { action_type: "" }] })}>
        Add candidate
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

interface StepPanelProps {
  index: number;
  count: number;
  step: Json;
  previousDelayLabel: string;
  isSchedule: boolean;
  copy: StepCopy | undefined;
  sharedWith: number;
  env: EditorEnv;
  problems: string[];
  onStep: (patch: Json) => void;
  onCopy: (c: StepCopy) => void;
  onMode: (mode: "fixed" | "ai") => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}

export function StepPanel({ index, count, step, previousDelayLabel, isSchedule, copy, sharedWith, env, problems, onStep, onCopy, onMode, onMove, onRemove }: StepPanelProps) {
  const d = env.disabled;
  const mode = stepMode(step);
  const delay = parseDelay(step.delay);
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[22px] font-semibold text-foreground">Email {index + 1}</h2>
          <p className="mt-0.5 text-[16px] text-muted-foreground">
            {isSchedule ? `Sent on slot ${String(step.order)} of the date schedule` : `Sent ${describeDelay(step.delay)} ${index === 0 ? "after the contact enters" : `after email ${index}`}`}
          </p>
        </div>
        {!d && (
          <div className="flex items-center gap-1">
            <Button type="button" size="icon" variant="ghost" aria-label="Move earlier" title="Move earlier" disabled={index === 0} onClick={() => onMove(-1)}>
              <ArrowUp />
            </Button>
            <Button type="button" size="icon" variant="ghost" aria-label="Move later" title="Move later" disabled={index === count - 1} onClick={() => onMove(1)}>
              <ArrowDown />
            </Button>
            {confirmRemove ? (
              <>
                <Button type="button" size="sm" variant="destructive" onClick={onRemove}>Remove email</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>Keep</Button>
              </>
            ) : (
              <Button type="button" size="icon" variant="ghost" aria-label="Remove this email" title="Remove this email" onClick={() => setConfirmRemove(true)}>
                <Trash2 />
              </Button>
            )}
          </div>
        )}
      </div>

      {problems.length > 0 && (
        <ul className="list-disc rounded-md border border-danger bg-danger-soft py-2 pl-8 pr-3 text-[15px] text-foreground" role="alert">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}

      <Section title="Who writes it">
        {mode === "choose" ? (
          <p className="text-[16px] text-muted-foreground">The AI picks one of several candidate emails for each contact (a choose step).</p>
        ) : (
          <>
            <Segmented
              value={mode}
              disabled={d}
              onChange={(v) => onMode(v as "fixed" | "ai")}
              options={[
                { value: "fixed", label: "I write it" },
                { value: "ai", label: "AI drafts it per contact", disabled: !env.hasLlm && mode !== "ai", title: env.hasLlm ? undefined : "Needs an LLM provider (Settings, LLM)." },
              ]}
            />
            <p className={HINT}>
              {mode === "fixed"
                ? "Everyone gets the same copy, with their details filled in. Works without an LLM."
                : "Each contact gets a draft written for their situation. It waits in Approvals if review is on."}
            </p>
          </>
        )}
      </Section>

      <div className="border-t border-border pt-5">
        {mode === "fixed" && copy && (
          <FixedCopyEditor step={step} copy={copy} onStep={onStep} onCopy={onCopy} env={env} sharedWith={sharedWith} stepIndex={index} />
        )}
        {mode === "fixed" && !copy && (
          <p className="text-[16px] text-muted-foreground">Loading the copy of template <code className="font-mono text-[14px]">{String(step.template_ref)}</code>...</p>
        )}
        {mode === "ai" && <AiEditor step={step} onStep={onStep} env={env} stepIndex={index} />}
        {mode === "choose" && <ChooseEditor step={step} onStep={onStep} env={env} stepIndex={index} />}
      </div>

      <Section title="When">
        {isSchedule ? (
          <p className="text-[16px] text-muted-foreground">
            A date schedule sends on its own dates (the trigger&apos;s offsets). Email {index + 1} serves slot {String(step.order)} and every later slot until the next email takes over.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[17px] text-foreground">
              <span>Send</span>
              <Input
                aria-label="Wait"
                type="number"
                min={0}
                className="w-20"
                value={String(delay.n)}
                disabled={d}
                onChange={(e) => onStep({ delay: formatDelay(Number(e.target.value), delay.unit) })}
              />
              <Select aria-label="Unit" className="w-32" value={delay.unit} disabled={d} onChange={(e) => onStep({ delay: formatDelay(delay.n, e.target.value as DelayUnit) })}>
                <option value="m">minutes</option>
                <option value="h">hours</option>
                <option value="d">days</option>
              </Select>
              <span>{index === 0 ? "after the contact enters" : `after email ${index} (${previousDelayLabel})`}</span>
            </div>
            <label className="mt-3 flex items-start gap-2 text-[16px] text-foreground">
              <input
                type="checkbox"
                className="mt-1"
                checked={step.window_policy === "immediate"}
                disabled={d}
                onChange={(e) => onStep({ window_policy: e.target.checked ? "immediate" : "respect_window" })}
              />
              <span>
                Send at once, even outside the send window
                <span className="block text-[15px] text-muted-foreground">For mail the contact is waiting for: a welcome, a receipt, a payment problem.</span>
              </span>
            </label>
          </>
        )}
      </Section>

      <Section title="Skip this email unless" hint="Checked right before sending. Empty: always sent.">
        <ConditionListEditor label="Conditions" value={toConditionList(step.condition)} onChange={(l) => onStep({ condition: l.length > 0 ? l : undefined })} scope="step" disabled={d} />
      </Section>

      <details className="border-t border-border pt-5">
        <summary className="cursor-pointer text-[17px] font-semibold text-foreground">Sender and advanced</summary>
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className={LABEL} htmlFor={`from-${index}`}>From name</label>
              <Input id={`from-${index}`} maxLength={120} placeholder="Sam from Acme" value={typeof step.from_name === "string" ? step.from_name : ""} disabled={d} onChange={(e) => onStep({ from_name: e.target.value || undefined })} />
              <p className={HINT}>The address stays your verified sender.</p>
            </div>
            <div>
              <label className={LABEL} htmlFor={`reply-${index}`}>Reply-to</label>
              <Input id={`reply-${index}`} placeholder="sam@example.com" value={typeof step.reply_to === "string" ? step.reply_to : ""} disabled={d} onChange={(e) => onStep({ reply_to: e.target.value || undefined })} />
            </div>
            <div>
              <label className={LABEL} htmlFor={`eyebrow-${index}`}>Label above the body</label>
              <Input id={`eyebrow-${index}`} maxLength={60} placeholder="Getting started" value={typeof step.eyebrow === "string" ? step.eyebrow : ""} disabled={d} onChange={(e) => onStep({ eyebrow: e.target.value || undefined })} />
            </div>
            <div>
              <label className={LABEL} htmlFor={`expires-${index}`}>Drop it if not sent within</label>
              <Input id={`expires-${index}`} placeholder="2d" value={typeof step.expires_after === "string" ? step.expires_after : ""} disabled={d} onChange={(e) => onStep({ expires_after: e.target.value || undefined })} />
              <p className={HINT}>For example 2d or 12h: a message not sent that long after it was created is cancelled, also while it waits for approval.</p>
            </div>
            {mode === "ai" && (
              <div className="sm:col-span-2">
                <label className={LABEL} htmlFor={`preheader-ai-${index}`}>Preview text</label>
                <Input id={`preheader-ai-${index}`} maxLength={200} value={typeof step.preheader === "string" ? step.preheader : ""} disabled={d} onChange={(e) => onStep({ preheader: e.target.value || undefined })} />
              </div>
            )}
          </div>
          <ConditionListEditor label="Leave the flow after this email if" value={toConditionList(step.exit_condition)} onChange={(l) => onStep({ exit_condition: l.length > 0 ? l : undefined })} scope="step" disabled={d} />
          <div>
            <label className={LABEL} htmlFor={`action-${index}`}>Internal name</label>
            <Input id={`action-${index}`} className="max-w-xs font-mono text-[15px]" value={typeof step.action_type === "string" ? step.action_type : ""} disabled={d} onChange={(e) => onStep({ action_type: e.target.value })} />
            <p className={HINT}>Shown in analytics and the sent log, and used by send-history conditions (&quot;was never sent welcome&quot;).</p>
          </div>
        </div>
      </details>
    </div>
  );
}
