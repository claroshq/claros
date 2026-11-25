/**
 * The flow as a timeline: what starts it, each email with the wait before
 * it, and what ends it early. Every node is a button that opens its editor
 * beside the timeline. A list, not a canvas: flows are linear plans.
 */
import { Fragment, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import type { StepCopy } from "../../api.js";
import { summarizeCondition, summarizeTrigger, toConditionList, type Json } from "../../lib/flow-model.js";
import { cumulativeMinutes, describeDelay, describeOffset, fillSample, stepMode, type EditorDraft } from "../../lib/flow-editor-model.js";

export type Selection = "trigger" | "prompt" | "exits" | number;

interface FlowTimelineProps {
  draft: EditorDraft;
  selected: Selection;
  onSelect: (s: Selection) => void;
  copyOf: (slug: string) => StepCopy | undefined;
  sample: Record<string, string>;
  problemsAt: (where: Selection) => number;
  onAdd: (mode: "fixed" | "ai") => void;
  canAddAi: boolean;
  disabled?: boolean;
}

const CARD =
  "w-full rounded-lg border bg-card px-3.5 py-2.5 text-left transition-[border-color,box-shadow] duration-(--dur-fast) hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function cardClass(active: boolean): string {
  return `${CARD} ${active ? "border-accent shadow-[0_0_0_3px_var(--accent-soft)]" : "border-border"}`;
}

function Dot({ children, dashed }: { children: ReactNode; dashed?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`absolute left-0 top-2.5 z-10 flex h-[26px] w-[26px] items-center justify-center rounded-full border-2 bg-background font-mono text-[12px] text-muted-foreground ${dashed ? "border-dashed border-border-strong" : "border-border-strong"}`}
    >
      {children}
    </span>
  );
}

function Problems({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-auto inline-flex items-center gap-1 text-[12px] font-medium text-danger">
      <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
      {count === 1 ? "1 thing to fix" : `${count} things to fix`}
    </span>
  );
}

function stepTitle(step: Json, copyOf: FlowTimelineProps["copyOf"], sample: Record<string, string>): { title: string; sub: string } {
  const mode = stepMode(step);
  if (mode === "fixed") {
    const copy = copyOf(String(step.template_ref));
    const subject = copy?.subject.trim() ? fillSample(copy.subject, sample) : "No subject yet";
    const pre = typeof step.preheader === "string" && step.preheader ? fillSample(step.preheader, sample) : copy ? fillSample(copy.body_html.replace(/<[^>]+>/g, " "), sample).replace(/\s+/g, " ").trim() : "";
    return { title: subject, sub: pre };
  }
  const instr = typeof step.brain_instruction === "string" ? step.brain_instruction.replace(/[#*`_>]/g, "").replace(/\s+/g, " ").trim() : "";
  if (mode === "choose") {
    const n = Array.isArray(step.candidates) ? step.candidates.length : 0;
    return { title: `The AI picks one of ${n} emails`, sub: instr };
  }
  return { title: "Written by the AI for each contact", sub: instr || "No instruction yet" };
}

export function FlowTimeline({ draft, selected, onSelect, copyOf, sample, problemsAt, onAdd, canAddAi, disabled }: FlowTimelineProps) {
  const offsets = cumulativeMinutes(draft.steps);
  const isSchedule = draft.trigger.type === "date_schedule";
  const where = toConditionList(draft.trigger.config.where);

  return (
    <ol className="relative list-none p-0" aria-label="Flow timeline">
      <span aria-hidden="true" className="absolute bottom-6 left-[12px] top-6 w-0.5 bg-border" />

      <li className="relative pl-10">
        <Dot>&#9656;</Dot>
        <button type="button" className={cardClass(selected === "trigger")} aria-current={selected === "trigger"} onClick={() => onSelect("trigger")}>
          <span className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
            Starts when
            <Problems count={problemsAt("trigger")} />
          </span>
          <span className="mt-0.5 block text-[14px] font-semibold text-foreground">
            {summarizeTrigger(draft.trigger.type, { ...draft.trigger.config, where: [] })}
          </span>
          {where.length > 0 && <span className="mt-0.5 block text-[13px] text-muted-foreground">only if {summarizeCondition(where)}</span>}
        </button>
      </li>

      {draft.prompt !== null && (
        <li className="relative mt-3 pl-10">
          <Dot>&#8801;</Dot>
          <button type="button" className={cardClass(selected === "prompt")} aria-current={selected === "prompt"} onClick={() => onSelect("prompt")}>
            <span className="text-[12px] font-medium text-muted-foreground">Described in a prompt</span>
            <span className="mt-0.5 line-clamp-2 block text-[13px] text-foreground">{draft.prompt || "No prompt yet"}</span>
          </button>
        </li>
      )}

      {draft.steps.map((step, i) => {
        const { title, sub } = stepTitle(step, copyOf, sample);
        const mode = stepMode(step);
        const cond = toConditionList(step.condition);
        return (
          <Fragment key={`${String(step.order)}-${i}`}>
          <li className="py-2 pl-10 text-[13px] text-muted-foreground">
              {isSchedule ? (
                <>on slot {String(step.order)} of the schedule</>
              ) : (
                <>
                  {i === 0 ? "then" : "wait"} <span className="font-medium text-foreground">{describeDelay(step.delay)}</span>
                  {offsets[i]! > 0 && <span> · {describeOffset(offsets[i]!)}</span>}
                  {step.window_policy === "immediate" && <span> · ignores the send window</span>}
                </>
              )}
          </li>
          <li className="relative pl-10">
            <Dot>{i + 1}</Dot>
            <button type="button" className={cardClass(selected === i)} aria-current={selected === i} onClick={() => onSelect(i)}>
              <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
                <span className={`rounded px-1.5 py-px text-[11px] font-medium ${mode === "fixed" ? "bg-sunken text-muted-foreground" : "bg-accent-soft text-accent-text"}`}>
                  {mode === "fixed" ? "Your copy" : mode === "choose" ? "AI picks" : "AI drafted"}
                </span>
                {cond.length > 0 && <span className="truncate">only if {summarizeCondition(cond)}</span>}
                <Problems count={problemsAt(i)} />
              </span>
              <span className="mt-1 block truncate text-[14px] font-semibold text-foreground">{title}</span>
              {sub && <span className="mt-0.5 block truncate text-[13px] text-muted-foreground">{sub}</span>}
            </button>
          </li>
          </Fragment>
        );
      })}

      {!disabled && (
        <li className="relative mt-4 flex flex-wrap gap-2 pl-10">
          <button
            type="button"
            onClick={() => onAdd("fixed")}
            className="flex-1 rounded-lg border border-dashed border-border-strong px-3 py-2 text-[14px] font-medium text-muted-foreground transition-colors hover:border-solid hover:text-foreground"
          >
            + Email I write
          </button>
          <button
            type="button"
            onClick={() => onAdd("ai")}
            disabled={!canAddAi}
            title={canAddAi ? undefined : "AI-drafted emails need an LLM provider (Settings, LLM)."}
            className="flex-1 rounded-lg border border-dashed border-border-strong px-3 py-2 text-[14px] font-medium text-muted-foreground transition-colors hover:border-solid hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            + Email the AI drafts
          </button>
        </li>
      )}

      <li className="relative mt-4 pl-10">
        <Dot dashed>&#9632;</Dot>
        <button type="button" className={cardClass(selected === "exits")} aria-current={selected === "exits"} onClick={() => onSelect("exits")}>
          <span className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
            Stops early when
            <Problems count={problemsAt("exits")} />
          </span>
          <span className="mt-0.5 block text-[14px] font-semibold text-foreground">
            {draft.exits.length === 0 ? "Never; it ends after the last email" : draft.exits.map((e) => summarizeCondition(e)).join(" or ")}
          </span>
        </button>
      </li>
    </ol>
  );
}
