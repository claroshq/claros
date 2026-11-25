/**
 * Condition builder for the flow editor: one condition (a leaf or a
 * combinator: all / any / not, nested up to four levels) or a list of
 * conditions (all must hold). A JSON mode edits the raw value for shapes
 * the form does not cover.
 */
import { useState } from "react";
import {
  HISTORY_OPS,
  KIND_LABELS,
  LIFECYCLE_STATES,
  MAX_CONDITION_DEPTH,
  TRAIT_OPS,
  conditionKind,
  emptyCondition,
  formatTraitValue,
  kindsFor,
  parseTraitValue,
  summarizeCondition,
  type Condition,
  type ConditionKind,
  type ConditionScope,
  type Json,
} from "../lib/flow-model.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Select } from "./ui/select.js";
import { Textarea } from "./ui/textarea.js";

const SMALL = "h-8 text-[13px]";

const TRAIT_OP_LABELS: Record<string, string> = {
  eq: "is",
  neq: "is not",
  in: "is one of",
  exists: "is set",
  not_exists: "is not set",
  gt: "greater than",
  lt: "less than",
};

const HISTORY_OP_LABELS: Record<string, string> = { none: "never sent", any: "sent at least once", count_lt: "sent fewer than" };

interface ConditionEditorProps {
  value: Condition;
  onChange: (c: Condition) => void;
  onRemove?: () => void;
  scope: ConditionScope;
  depth?: number;
  disabled?: boolean;
}

/** One condition. */
export function ConditionEditor({ value, onChange, onRemove, scope, depth = 1, disabled }: ConditionEditorProps) {
  const kind = conditionKind(value);
  const kinds = kindsFor(scope).filter((k) => depth < MAX_CONDITION_DEPTH || !["all", "any", "not"].includes(k));
  const inner = kind ? (value as Json)[kind] : undefined;
  const set = (v: unknown) => onChange({ [kind!]: v });

  return (
    <div className="rounded-md border border-border bg-card p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Condition kind"
          className={`${SMALL} w-48`}
          value={kind ?? ""}
          disabled={disabled}
          onChange={(e) => onChange(emptyCondition(e.target.value as ConditionKind))}
        >
          {kind === null && <option value="">Unknown shape</option>}
          {kinds.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </Select>

        {kind === "trait" && <TraitFields value={(inner ?? {}) as Json} onChange={set} disabled={disabled} />}
        {kind === "history" && <HistoryFields value={(inner ?? {}) as Json} onChange={set} disabled={disabled} />}
        {kind === "first_contact" && (
          <Select aria-label="First contact" className={`${SMALL} w-56`} value={inner === false ? "false" : "true"} disabled={disabled} onChange={(e) => set(e.target.value === "true")}>
            <option value="true">nothing sent yet</option>
            <option value="false">something was sent</option>
          </Select>
        )}
        {(kind === "lifecycle_state" || kind === "lifecycle_state_not") && (
          <Select aria-label="Lifecycle state" className={`${SMALL} w-40`} value={String(inner ?? "")} disabled={disabled} onChange={(e) => set(e.target.value)}>
            {LIFECYCLE_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        )}
        {kind === "lifecycle_state_change" && (
          <Select
            aria-label="Becomes lifecycle state"
            className={`${SMALL} w-40`}
            value={String((inner as Json | undefined)?.to ?? "")}
            disabled={disabled}
            onChange={(e) => set({ to: e.target.value })}
          >
            {LIFECYCLE_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        )}
        {(kind === "event_since_step" || kind === "event") && (
          <Input aria-label="Event name" className={`${SMALL} w-56`} value={String(inner ?? "")} placeholder="event_name" disabled={disabled} onChange={(e) => set(e.target.value)} />
        )}
        {kind === "date_unchanged" && <span className="text-[13px] text-muted-foreground">the enrolled date still equals the trait</span>}
        {kind === null && <span className="font-mono text-[12px] text-muted-foreground">{JSON.stringify(value)}</span>}

        {onRemove && (
          <Button type="button" size="sm" variant="ghost" className="ml-auto h-8" disabled={disabled} onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>

      {(kind === "all" || kind === "any") && (
        <div className="mt-2 pl-4">
          <ConditionItems
            items={Array.isArray(inner) ? (inner as Condition[]) : []}
            onChange={(items) => set(items)}
            scope={scope}
            depth={depth + 1}
            disabled={disabled}
          />
        </div>
      )}
      {kind === "not" && (
        <div className="mt-2 pl-4">
          <ConditionEditor value={(inner ?? emptyCondition("trait")) as Condition} onChange={set} scope={scope} depth={depth + 1} disabled={disabled} />
        </div>
      )}
    </div>
  );
}

function TraitFields({ value, onChange, disabled }: { value: Json; onChange: (v: Json) => void; disabled?: boolean }) {
  const op = String(value.op ?? "eq");
  const needsValue = op !== "exists" && op !== "not_exists";
  const [raw, setRaw] = useState(formatTraitValue(value.value));
  return (
    <>
      <Input aria-label="Trait key" className={`${SMALL} w-40`} placeholder="plan_tier" value={String(value.key ?? "")} disabled={disabled} onChange={(e) => onChange({ ...value, key: e.target.value })} />
      <Select
        aria-label="Trait operator"
        className={`${SMALL} w-36`}
        value={op}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value;
          const rest: Json = { key: value.key, op: next };
          if (next !== "exists" && next !== "not_exists") rest.value = parseTraitValue(raw, next);
          onChange(rest);
        }}
      >
        {TRAIT_OPS.map((o) => (
          <option key={o} value={o}>
            {TRAIT_OP_LABELS[o]}
          </option>
        ))}
      </Select>
      {needsValue && (
        <Input
          aria-label="Trait value"
          className={`${SMALL} w-44`}
          placeholder={op === "in" ? "pro, business" : "value"}
          value={raw}
          disabled={disabled}
          onChange={(e) => {
            setRaw(e.target.value);
            onChange({ ...value, value: parseTraitValue(e.target.value, op) });
          }}
        />
      )}
    </>
  );
}

function HistoryFields({ value, onChange, disabled }: { value: Json; onChange: (v: Json) => void; disabled?: boolean }) {
  const filter = value.flow !== undefined ? "flow" : value.action_type !== undefined ? "action_type" : value.topic !== undefined ? "topic" : "";
  const op = String(value.op ?? "none");
  const base = (): Json => {
    const { flow: _f, action_type: _a, topic: _t, ...rest } = value;
    return rest;
  };
  return (
    <>
      <Select aria-label="History operator" className={`${SMALL} w-44`} value={op} disabled={disabled} onChange={(e) => {
        const next: Json = { ...value, op: e.target.value };
        if (e.target.value !== "count_lt") delete next.value;
        else next.value = 1;
        onChange(next);
      }}>
        {HISTORY_OPS.map((o) => (
          <option key={o} value={o}>
            {HISTORY_OP_LABELS[o]}
          </option>
        ))}
      </Select>
      {op === "count_lt" && (
        <Input aria-label="Count" type="number" min={1} className={`${SMALL} w-20`} value={String(value.value ?? 1)} disabled={disabled} onChange={(e) => onChange({ ...value, value: Number(e.target.value) })} />
      )}
      <Select aria-label="History filter" className={`${SMALL} w-36`} value={filter} disabled={disabled} onChange={(e) => {
        const next = base();
        if (e.target.value) next[e.target.value] = "";
        onChange(next);
      }}>
        <option value="">any mail</option>
        <option value="flow">of flow</option>
        <option value="action_type">of action type</option>
        <option value="topic">of topic</option>
      </Select>
      {filter && (
        <Input aria-label="History filter value" className={`${SMALL} w-36`} value={String(value[filter] ?? "")} placeholder="slug" disabled={disabled} onChange={(e) => onChange({ ...value, [filter]: e.target.value })} />
      )}
      <Input
        aria-label="Within"
        className={`${SMALL} w-24`}
        placeholder="within 7d"
        value={String(value.within ?? "")}
        disabled={disabled}
        onChange={(e) => {
          const next = { ...value };
          if (e.target.value === "") delete next.within;
          else next.within = e.target.value;
          onChange(next);
        }}
      />
    </>
  );
}

function ConditionItems({
  items,
  onChange,
  scope,
  depth,
  disabled,
}: {
  items: Condition[];
  onChange: (items: Condition[]) => void;
  scope: ConditionScope;
  depth: number;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      {items.map((c, i) => (
        <ConditionEditor
          key={i}
          value={c}
          scope={scope}
          depth={depth}
          disabled={disabled}
          onChange={(next) => onChange(items.map((x, j) => (j === i ? next : x)))}
          onRemove={() => onChange(items.filter((_, j) => j !== i))}
        />
      ))}
      <Button type="button" size="sm" variant="outline" className="h-8" disabled={disabled} onClick={() => onChange([...items, emptyCondition("trait")])}>
        Add condition
      </Button>
    </div>
  );
}

interface ConditionListEditorProps {
  /** The conditions; all must hold (a list in the document). */
  value: Condition[];
  onChange: (list: Condition[]) => void;
  scope: ConditionScope;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** The entries are alternatives (plan exit conditions: any one fires). */
  anyOf?: boolean;
}

/** A list of conditions that must all hold (or, with anyOf, any one), with a JSON mode. */
export function ConditionListEditor({ value, onChange, scope, label, hint, disabled, anyOf }: ConditionListEditorProps) {
  const [json, setJson] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-foreground">{label}</p>
        <button
          type="button"
          className="text-[12px] text-accent-text hover:underline"
          disabled={disabled}
          onClick={() => {
            if (json === null) {
              setJson(JSON.stringify(value, null, 2));
              setJsonError(null);
            } else {
              setJson(null);
            }
          }}
        >
          {json === null ? "Edit as JSON" : "Back to the form"}
        </button>
      </div>
      {hint && <p className="mb-1.5 text-[12px] text-muted-foreground">{hint}</p>}
      {json !== null ? (
        <div>
          <Textarea
            aria-label={`${label} as JSON`}
            className="min-h-28 font-mono text-[12px]"
            value={json}
            disabled={disabled}
            onChange={(e) => {
              setJson(e.target.value);
              try {
                const parsed: unknown = JSON.parse(e.target.value);
                const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : null;
                if (!list) throw new Error("a condition object or a list of them");
                setJsonError(null);
                onChange(list as Condition[]);
              } catch (err) {
                setJsonError(err instanceof Error ? err.message : "invalid JSON");
              }
            }}
          />
          {jsonError && <p className="mt-1 text-[12px] text-danger">{jsonError}</p>}
        </div>
      ) : (
        <>
          <ConditionItems items={value} onChange={onChange} scope={scope} depth={1} disabled={disabled} />
          {value.length > 0 && <p className="mt-1.5 text-[12px] text-muted-foreground">Reads: {anyOf ? value.map((c) => `(${summarizeCondition(c)})`).join(" or ") : summarizeCondition(value)}</p>}
        </>
      )}
    </div>
  );
}
