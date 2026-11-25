/**
 * The `choose` step (G27 / D19): the LLM picks one eligible candidate.
 *
 * Deterministic filters run first, in code, before any LLM call, in this
 * order per candidate (the first that applies is the reason):
 *   consent        the contact is unsubscribed from the flow's topic
 *   throttle       the contact is at the product's daily or weekly cap
 *                  (critical flows with critical_bypass_throttle skip it)
 *   cooldown       the candidate's action type was sent within `cooldown`
 *                  (sent and imported history both count)
 *   when           a `when` condition does not hold
 *   kb_exhausted   kb_select has no unused entry left for the contact
 *   context_empty  a context source returned no data
 *   context_error  a context source failed
 * Nothing eligible: the decision is `none` without an LLM call. Otherwise
 * the LLM sees the eligible candidates only and answers {choice, reason}; a
 * choice outside the eligible set (or `none` when allow_none is false) is
 * rejected and asked once more, then recorded as `none`.
 *
 * A regenerate with a forced action type (G20) may force any declared
 * candidate; its filter result is kept as a warning on the decision.
 *
 * The decision {choice, eligible, filtered_out: [{action_type, reason}],
 * reason, forced?, warning?} is stored on the message (choose_decision) and
 * shown in approvals; a choose.decided outbox event feeds the analytics sink
 * (G30).
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor, type WorkerContentKbEntry } from "@claros/store";
import {
  cachedConditionContext,
  evaluateAllContactConditions,
  durationMs,
  resolveThrottleConfig,
  topicBlocks,
  type ChooseCandidate,
  type CompiledStep,
} from "@claros/core";
import { chooseCandidate, type DraftPromptContext, type LlmProvider } from "@claros/brain-oss";
import { fetchStepContext } from "./context-fetch.js";
import { eligibleKbEntries, pickKbEntry } from "./kb-select.js";

type Db = NodePgDatabase<Record<string, never>>;

export interface ChooseDecision {
  choice: string;
  eligible: string[];
  filtered_out: Array<{ action_type: string; reason: string }>;
  reason: string;
  forced?: boolean;
  warning?: string;
  rejected_answers?: string[];
}

export interface ChoosePick {
  candidate: ChooseCandidate;
  snapshot?: Record<string, unknown>;
  kbEntry?: WorkerContentKbEntry;
}

export type ChooseResult =
  | { kind: "picked"; decision: ChooseDecision; pick: ChoosePick }
  | { kind: "none"; decision: ChooseDecision }
  | { kind: "llm_error"; error: string; statusCode?: number | null; decision: ChooseDecision };

export interface ChooseInput {
  tenantId: string;
  contactId: string;
  flowId: string;
  messageId: string;
  stepOrder: number;
  step: CompiledStep;
  settings: Record<string, unknown>;
  product: string;
  flowSlug: string | null;
  flowClass: string;
  contact: { external_id: string; email: string | null; traits: Record<string, unknown> };
  forcedActionType?: string | null;
  now: Date;
  /** Resolves the LLM provider lazily (no call when nothing is eligible). */
  provider: () => Promise<LlmProvider | { error: string }>;
  draftCtx: DraftPromptContext;
  countCall?: (ok: boolean) => void;
}

const DAY = 86_400_000;

/** Run the deterministic filters for every candidate. */
async function filterCandidates(db: Db, input: ChooseInput): Promise<{ eligible: ChoosePick[]; filtered: ChooseDecision["filtered_out"]; all: Map<string, ChoosePick> }> {
  const store = storeFor(db).workerContent;
  const cands = input.step.candidates ?? [];
  const cond = cachedConditionContext({
    now: input.now,
    traits: async () => input.contact.traits,
    countSends: (f) => store.countSends({ tenantId: input.tenantId, contactId: input.contactId, ...f }),
  });

  // Flow-wide gates: consent and throttle apply to every candidate alike.
  let common: string | null = null;
  const gate = await store.getFlowTopicGate({ tenantId: input.tenantId, contactId: input.contactId, flowId: input.flowId });
  if (gate && topicBlocks(gate)) common = "consent";
  if (!common) {
    const cfg = resolveThrottleConfig(input.settings);
    const bypass = input.flowClass === "critical" && cfg.critical_bypass_throttle;
    if (!bypass) {
      const day = await cond.countSends({ since: new Date(input.now.getTime() - DAY) });
      const week = await cond.countSends({ since: new Date(input.now.getTime() - 7 * DAY) });
      if (day >= cfg.max_emails_per_user_per_day || week >= cfg.max_emails_per_user_per_week) common = "throttle";
    }
  }

  const eligible: ChoosePick[] = [];
  const filtered: ChooseDecision["filtered_out"] = [];
  const all = new Map<string, ChoosePick>();
  for (const c of cands) {
    const pick: ChoosePick = { candidate: c };
    all.set(c.action_type, pick);
    const reason = common ?? (await candidateReason(db, input, c, pick, cond));
    if (reason) filtered.push({ action_type: c.action_type, reason });
    else eligible.push(pick);
  }
  return { eligible, filtered, all };
}

async function candidateReason(
  db: Db,
  input: ChooseInput,
  c: ChooseCandidate,
  pick: ChoosePick,
  cond: ReturnType<typeof cachedConditionContext>,
): Promise<string | null> {
  if (c.cooldown) {
    const ms = durationMs(c.cooldown) ?? 0;
    const n = await cond.countSends({ actionType: c.action_type, since: new Date(input.now.getTime() - ms) });
    if (n > 0) return "cooldown";
  }
  if (c.when && c.when.length > 0) {
    const ok = await evaluateAllContactConditions(c.when, cond);
    if (ok !== true) return "when";
  }
  if (c.kb_select) {
    const entries = await eligibleKbEntries(db, {
      tenantId: input.tenantId,
      contactId: input.contactId,
      messageId: input.messageId,
      select: c.kb_select,
      traits: input.contact.traits,
    });
    const entry = pickKbEntry(entries, c.kb_select.pick, `${c.brain_instruction ?? ""} ${c.action_type}`);
    if (!entry) return "kb_exhausted";
    pick.kbEntry = entry;
  }
  if (c.context && c.context.length > 0) {
    const r = await fetchStepContext({
      settings: input.settings,
      product: input.product,
      contact: input.contact,
      flowSlug: input.flowSlug,
      stepOrder: input.stepOrder,
      messageId: input.messageId,
      entries: c.context,
      now: input.now,
    });
    if (!r.ok) return "context_error";
    if (r.empty) return "context_empty";
    pick.snapshot = r.snapshot;
  }
  return null;
}

function describe(p: ChoosePick): string {
  const parts: string[] = [];
  if (p.candidate.brain_instruction) parts.push(p.candidate.brain_instruction.slice(0, 300));
  if (p.kbEntry) parts.push(`topic: ${p.kbEntry.title}`);
  if (p.snapshot) parts.push("has fresh data from the product");
  return parts.join("; ");
}

export async function runChoose(db: Db, input: ChooseInput): Promise<ChooseResult> {
  const { eligible, filtered, all } = await filterCandidates(db, input);
  const eligibleTypes = eligible.map((p) => p.candidate.action_type);
  const base = { eligible: eligibleTypes, filtered_out: filtered };

  if (input.forcedActionType) {
    const pick = all.get(input.forcedActionType);
    if (!pick) {
      return { kind: "none", decision: { ...base, choice: "none", reason: `forced action '${input.forcedActionType}' is not a candidate of this step`, forced: true } };
    }
    const warn = filtered.find((f) => f.action_type === input.forcedActionType);
    return {
      kind: "picked",
      pick,
      decision: { ...base, choice: input.forcedActionType, reason: "forced by a reviewer", forced: true, ...(warn ? { warning: `filtered out: ${warn.reason}` } : {}) },
    };
  }

  if (eligible.length === 0) {
    return { kind: "none", decision: { ...base, choice: "none", reason: "no eligible candidate" } };
  }

  const provider = await input.provider();
  if ("error" in provider) return { kind: "llm_error", error: provider.error, statusCode: 401, decision: { ...base, choice: "none", reason: provider.error } };
  const allowNone = input.step.allow_none ?? true;
  const rejected: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chooseCandidate(provider, {
      ctx: input.draftCtx,
      candidates: eligible.map((p) => ({ action_type: p.candidate.action_type, description: describe(p) })),
      allowNone,
      retryNote: rejected.length > 0 ? `Your previous answer "${rejected[rejected.length - 1]}" is not one of the candidates. Answer with one action_type from the list${allowNone ? ' or "none"' : ""}.` : undefined,
    });
    input.countCall?.(r.ok);
    if (!r.ok) return { kind: "llm_error", error: r.error, statusCode: r.statusCode, decision: { ...base, choice: "none", reason: r.error } };
    const { choice, reason } = r.value;
    if (choice === "none" && allowNone) {
      return { kind: "none", decision: { ...base, choice: "none", reason, ...(rejected.length ? { rejected_answers: rejected } : {}) } };
    }
    const pick = eligible.find((p) => p.candidate.action_type === choice);
    if (pick) {
      return { kind: "picked", pick, decision: { ...base, choice, reason, ...(rejected.length ? { rejected_answers: rejected } : {}) } };
    }
    rejected.push(choice);
  }
  return { kind: "none", decision: { ...base, choice: "none", reason: "the model answered outside the eligible set twice", rejected_answers: rejected } };
}
