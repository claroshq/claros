/**
 * Flow status actions shared by the HTTP routes (routes/flows.ts) and the
 * MCP tools (mcp/tools.ts).
 */
import { storeFor, type ApiFlowsQueries } from "@claros/store";
import { validateStatusTransition, type FlowStatus } from "@claros/core";
import type { ServiceContext } from "./messages.js";

type FlowRow = NonNullable<Awaited<ReturnType<ApiFlowsQueries["findFlow"]>>>;

const UUID_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Outcome of pause or resume:
 * - ok: the status changed; unchanged: it already had the target status;
 * - invalid: the status rules do not allow it (HTTP 422), with the reason;
 * - conflict: the status changed concurrently (HTTP 409); not_found.
 */
export type FlowStatusResult =
  | { kind: "ok" | "unchanged"; flow: FlowRow }
  | { kind: "invalid"; error: string }
  | { kind: "conflict" }
  | { kind: "not_found" };

/** A non-archived flow of the product by id, or by slug. */
export async function findFlowByRef(ctx: Pick<ServiceContext, "db" | "tenant">, ref: string): Promise<FlowRow | null> {
  const store = storeFor(ctx.db).apiFlows;
  if (UUID_REF.test(ref)) return store.findFlow({ tenantId: ctx.tenant.id, id: ref.toLowerCase() });
  return (await store.listFlows({ tenantId: ctx.tenant.id, includeArchived: false })).find((f) => f.slug === ref) ?? null;
}

/** Pause an active flow ("paused") or resume a paused one ("active"), by id or slug. */
export async function setFlowStatus(
  ctx: Pick<ServiceContext, "db" | "tenant">,
  ref: string,
  target: "paused" | "active",
): Promise<FlowStatusResult> {
  const current = await findFlowByRef(ctx, ref);
  if (!current) return { kind: "not_found" };
  const from = current.status as FlowStatus;
  if (from === target) return { kind: "unchanged", flow: current };
  const transitionError = validateStatusTransition(from, target);
  if (transitionError) return { kind: "invalid", error: transitionError };
  if (target === "active" && (current.compileStatus !== "ready" || current.compiledPlan === null)) {
    return { kind: "invalid", error: "Cannot activate a flow without a compiled plan." };
  }
  const updated = await storeFor(ctx.db).apiFlows.updateFlow({
    tenantId: ctx.tenant.id,
    id: current.id,
    patch: { status: target, updatedAt: new Date() },
    expectedStatus: from,
  });
  if (!updated) return { kind: "conflict" };
  return { kind: "ok", flow: updated };
}
