/**
 * Context packet builder - slice 18.3: flow step metadata.
 *
 * Extracts the `brain_instruction` for the current step from the flow's
 * compiled plan, and resolves `sender_name` (from transport_configs.from_name)
 * and `product_name` (from tenants.name) for the context packet.
 *
 * Design constraints and decisions:
 *
 * brain_instruction extraction:
 *   - The compiled plan is a JSONB column validated by compiledPlanSchema at
 *     compile time. At read time we treat it defensively: a NULL plan, a
 *     step_order beyond the end of the steps array, and a step that carries
 *     no brain_instruction are all handled without throwing. Each case returns
 *     `brainInstruction: undefined` so the assembler receives an absent field
 *     rather than an error.
 *   - Exception: a plan that fails schema validation is not a normal absence.
 *     It means persisted data is corrupt or was written by an older schema
 *     version. In this case the absent return value is still correct, but a
 *     console.warn is emitted at warn level with flowId, tenantId, step_order,
 *     and the Zod error details so the failure can be identified and
 *     investigated. No exception is thrown.
 *   - Steps are keyed by their `order` field (1-based), not by array position.
 *     The LLM may produce steps out of array order; we find the step whose
 *     order matches the requested step_order.
 *   - Only the `brain_instruction` string is extracted. Template_ref, kb_ref,
 *     and condition fields are left for the assembler and execution engine.
 *
 * sender_name and product_name:
 *   - sender_name: from transport_configs WHERE is_active = true AND tenant_id
 *     = tenantId. The active config's from_name column is nullable - absent
 *     when the tenant has not set a display name. If no active config exists
 *     (Phase 1: transport is Phase 4), the field is absent.
 *   - product_name: from tenants.name, which is NOT NULL by schema. Always
 *     present when the tenant row exists. We treat it as always available.
 *   - The draft prompt (brain-oss) uses these fields conditionally:
 *       if (ctx.product_name || ctx.sender_name) { ... }
 *     so absent values simply mean the prompt omits that line. No fabrication.
 *
 * Absent-not-fabricated rule:
 *   All optional fields use `undefined` (omitted from returned object) rather
 *   than empty strings, placeholder text, or null values.
 *
 * All queries are scoped by tenant_id. Deterministic results.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { compiledPlanSchema } from "@claros/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

/** Flow step metadata section of the context packet. */
export interface FlowStepSection {
  /**
   * The brain_instruction from the compiled plan for this step.
   * Absent when:
   *   - the flow has no compiled plan (compile_status != ready)
   *   - the step_order does not exist in the plan
   *   - the matching step carries no brain_instruction
   */
  brainInstruction?: string;
  /**
   * The kb_ref from the compiled plan for this step.
   * When present, the KB context builder will always include this entry
   * (author intent beats similarity scoring).
   * Absent when the step carries no @kb reference.
   */
  kbRef?: string;
  /**
   * The template_ref from the compiled plan for this step.
   * When present, the step uses deterministic template rendering instead of
   * LLM-generated content: decide, draft, and assess are all skipped.
   * Absent when the step carries no @template reference.
   */
  templateRef?: string;
  /**
   * The sender display name from transport_configs.from_name.
   * Absent when no active transport config exists or from_name is null.
   */
  senderName?: string;
  /**
   * The tenant/product name from tenants.name.
   * Always present when the tenant row is found.
   */
  productName?: string;
  /**
   * The tenant-level product description from tenants.settings.brain_context.
   * Seeded by business model templates, editable via PATCH /v1/settings/tenant.
   * Absent when the tenant has no brain_context set.
   */
  brainContext?: string;
}

// ---------------------------------------------------------------------------
// Raw DB row types
// ---------------------------------------------------------------------------

type FlowPlanRow = Record<string, unknown> & {
  compiled_plan: unknown; // JSONB arrives as parsed object or null
};

type TransportRow = Record<string, unknown> & {
  from_name: string | null;
};

type TenantRow = Record<string, unknown> & {
  name: string;
  settings: unknown; // JSONB arrives as parsed object or null
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Fetch the flow step metadata section of the context packet.
 *
 * Issues two queries:
 *   1. SELECT compiled_plan FROM flows WHERE id = flowId AND tenant_id = tenantId
 *      Then extract the brain_instruction for the given step_order.
 *   2. SELECT from_name FROM transport_configs WHERE tenant_id = tenantId
 *      AND is_active = true LIMIT 1
 *      Plus SELECT name FROM tenants WHERE id = tenantId.
 *
 * Both queries are scoped by tenantId to prevent cross-tenant data leaks.
 *
 * @param db         - Drizzle database instance (node-postgres).
 * @param tenantId   - The tenant that owns this flow.
 * @param flowId     - The flow whose compiled plan to read.
 * @param stepOrder  - The 1-based step order for the current execution step.
 * @returns FlowStepSection with available fields populated.
 */
export async function buildFlowStepSection(
  db: Db,
  tenantId: string,
  flowId: string,
  stepOrder: number,
): Promise<FlowStepSection> {
  // -------------------------------------------------------------------------
  // Query 1: compiled plan from flows table
  // -------------------------------------------------------------------------
  const flowRows = await db.execute<FlowPlanRow>(sql`
    SELECT compiled_plan
    FROM flows
    WHERE id        = ${flowId}::uuid
      AND tenant_id = ${tenantId}::uuid
  `);

  let brainInstruction: string | undefined;
  let kbRef: string | undefined;
  let templateRef: string | undefined;

  if (flowRows.rows.length > 0) {
    const rawPlan = flowRows.rows[0]!.compiled_plan;

    if (rawPlan != null) {
      // Defensively validate the compiled plan against the schema.
      // If the stored JSON is malformed or from an older schema version,
      // safeParse returns success=false and we treat instruction as absent.
      const parsed = compiledPlanSchema.safeParse(rawPlan);
      if (parsed.success) {
        const step = parsed.data.steps.find((s) => s.order === stepOrder);
        // step may be undefined (stepOrder beyond end of plan) - that is
        // handled by the optional chain: fields stay undefined.
        if (step?.brain_instruction) {
          brainInstruction = step.brain_instruction;
        }
        if (step?.kb_ref) {
          kbRef = step.kb_ref;
        }
        if (step?.template_ref) {
          templateRef = step.template_ref;
        }
      } else {
        // schema validation failure -> fields remain undefined, but this
        // is NOT a normal absence: it means persisted data is corrupt or was written
        // by an older schema version that is now unreadable. Log at warn with enough
        // context to identify the affected flow and step for investigation.
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        console.warn(
          `[context-flow] compiled_plan schema validation failed for flow ${flowId} ` +
            `(tenant ${tenantId}, step_order ${stepOrder}): ${issues}`,
        );
      }
    }
    // compiled_plan is null -> fields remain undefined
  }
  // flow not found (wrong tenant or bad id) -> fields remain undefined

  // -------------------------------------------------------------------------
  // Query 2a: sender name from active transport config
  // -------------------------------------------------------------------------
  const transportRows = await db.execute<TransportRow>(sql`
    SELECT from_name
    FROM transport_configs
    WHERE tenant_id = ${tenantId}::uuid
      AND is_active = true
    LIMIT 1
  `);

  let senderName: string | undefined;
  if (transportRows.rows.length > 0) {
    const fromName = transportRows.rows[0]!.from_name;
    // from_name is nullable: absent rather than fabricated when null
    if (fromName != null) {
      senderName = fromName;
    }
  }

  // -------------------------------------------------------------------------
  // Query 2b: product name and brain_context from tenants
  // -------------------------------------------------------------------------
  const tenantRows = await db.execute<TenantRow>(sql`
    SELECT name, settings
    FROM tenants
    WHERE id = ${tenantId}::uuid
  `);

  let productName: string | undefined;
  let brainContext: string | undefined;
  if (tenantRows.rows.length > 0) {
    // tenants.name is NOT NULL by schema - always a string when the row exists
    productName = tenantRows.rows[0]!.name;

    // settings.brain_context is optional; absent rather than fabricated.
    // Non-string values (corrupt settings JSON) are treated as absent.
    const settings = tenantRows.rows[0]!.settings as Record<string, unknown> | null;
    const rawBrainContext = settings?.brain_context;
    if (typeof rawBrainContext === "string" && rawBrainContext.trim().length > 0) {
      brainContext = rawBrainContext;
    }
  }

  // -------------------------------------------------------------------------
  // Assemble result
  // -------------------------------------------------------------------------
  const result: FlowStepSection = {};
  if (brainInstruction !== undefined) result.brainInstruction = brainInstruction;
  if (kbRef !== undefined) result.kbRef = kbRef;
  if (templateRef !== undefined) result.templateRef = templateRef;
  if (senderName !== undefined) result.senderName = senderName;
  if (productName !== undefined) result.productName = productName;
  if (brainContext !== undefined) result.brainContext = brainContext;
  return result;
}
