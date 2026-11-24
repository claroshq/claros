/**
 * Flow CRUD routes.
 *
 * All routes require session-cookie authentication (dashboard operator scope).
 * They are registered under the /v1 prefix inside the authenticated scope in
 * app.ts, which enforces request.tenant !== null before any route handler runs.
 *
 * Scope separation reminder: these routes share the /v1 prefix with the
 * ingestion scope, but are in a different router scope. The ingest
 * middleware (bearer token) does not run here; the dashboard middleware
 * (session cookie) does. A bearer-key-only request reaching these routes will
 * have request.tenant === null and be rejected by the /v1 role check
 * before the route handler runs.
 *
 * Endpoints:
 *   POST   /v1/flows              create a flow
 *   GET    /v1/flows              list flows (excludes archived; ?include_archived=true)
 *   GET    /v1/flows/:id          get a single flow
 *   PATCH  /v1/flows/:id          update a flow (partial; status transitions validated)
 *   DELETE /v1/flows/:id          archive a flow (sets status = 'archived')
 *
 * Ownership rules:
 *   - prompt_source: writable by API (create and update when status is draft or paused)
 *   - compiled_plan, compiled_at: owned by the compile worker (task 11); never writable
 *     by the API client. If prompt_source changes (draft/paused only), compiled_plan and
 *     compiled_at are cleared to signal the plan is now stale.
 *   - status starts as 'draft' on create; transitions are validated against the table in
 *     @claros/core (validateStatusTransition). archived is terminal.
 *
 * Cross-tenant isolation: any flow that exists but belongs to a different tenant
 * returns 404 (not 403) to avoid leaking information about other tenants.
 */
import { RoleRouter } from "../http/router.js";
import type { AppContext } from "../http/env.js";
import { z } from "zod";
import { eq, and, ne } from "drizzle-orm";
import { flows, llmConfigs, tenants, templates } from "@claros/db/schema";
import {
  isValidDelay,
  validateStatusTransition,
  FLOW_TRIGGER_TYPES,
  FLOW_STATUSES,
  FLOW_CLASSES,
  REENTRY_POLICIES,
  FLOW_SOURCES,
  APPROVAL_MODES,
  CONTENT_MODES,
  QUEUE,
  compiledPlanSchema,
  type FlowStatus,
} from "@claros/core";
import { decrypt, parseEncryptionKey } from "@claros/adapters";
import { OpenAICompatibleProvider, draft } from "@claros/brain-oss";
import type { Db } from "../plugins/db.js";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const flowStepSchema = z
  .object({
    order: z.number().int().min(1),
    action_type: z.string().min(1),
    delay: z.string().refine(isValidDelay, {
      message: "delay must be a non-negative integer followed by a unit: m, h, or d (e.g. '0m', '2h', '3d')",
    }),
    window_policy: z.enum(["immediate", "respect_window"]),
    template_ref: z.string().optional(),
    kb_ref: z.string().optional(),
    condition: z.unknown().optional(),
    exit_condition: z.unknown().optional(),
  })
  .passthrough(); // allow brain_instruction and any future fields from compilation

const createFlowSchema = z.object({
  name: z.string().min(1, "name is required"),
  description: z.string().optional(),
  priority: z.number().int().optional(),
  trigger_type: z.enum(
    FLOW_TRIGGER_TYPES as [string, ...string[]],
    { errorMap: () => ({ message: `trigger_type must be one of: ${FLOW_TRIGGER_TYPES.join(", ")}` }) },
  ),
  trigger_config: z.record(z.unknown()),
  steps: z.array(flowStepSchema).min(0),
  source: z
    .enum(FLOW_SOURCES as [string, ...string[]])
    .optional(),
  content_mode: z
    .enum(CONTENT_MODES as [string, ...string[]])
    .optional(),
  approval_mode: z
    .enum(APPROVAL_MODES as [string, ...string[]])
    .optional(),
  flow_class: z
    .enum(FLOW_CLASSES as [string, ...string[]])
    .optional(),
  reentry_policy: z
    .enum(REENTRY_POLICIES as [string, ...string[]])
    .optional(),
  reentry_cooldown_days: z.number().int().min(1).optional(),
  prompt_source: z.string().optional(),
});

// Update: all create fields optional, plus status
const updateFlowSchema = createFlowSchema
  .partial()
  .extend({
    status: z
      .enum(FLOW_STATUSES as [string, ...string[]])
      .optional(),
  });

export type CreateFlowBody = z.infer<typeof createFlowSchema>;
export type UpdateFlowBody = z.infer<typeof updateFlowSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return 400 with Zod validation issues.
 */
function validationError(c: AppContext, issues: z.ZodIssue[]) {
  return c.json({
    error: "Validation failed",
    issues: issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  }, 400);
}

/**
 * Validate that step.order values are unique within the array.
 * Returns an error string if duplicate orders exist, null otherwise.
 */
function validateStepOrders(steps: Array<{ order: number }>): string | null {
  const seen = new Set<number>();
  for (const step of steps) {
    if (seen.has(step.order)) {
      return `Duplicate step order: ${step.order}. Each step must have a unique order value.`;
    }
    seen.add(step.order);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export default function flowsRoutes() {
  const r = new RoleRouter();
  /**
   * POST /v1/flows
   * Create a new flow. Always starts with status = 'draft'.
   */
  r.post("/", "member", async (c) => {
    const parsed = createFlowSchema.safeParse(c.var.body);
    if (!parsed.success) {
      return validationError(c, parsed.error.issues);
    }

    const body = parsed.data;
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    // Validate step order uniqueness
    if (body.steps.length > 0) {
      const orderError = validateStepOrders(body.steps);
      if (orderError) {
        return c.json({ error: orderError }, 400);
      }
    }

    const [inserted] = await db
      .insert(flows)
      .values({
        tenantId,
        name: body.name,
        description: body.description ?? null,
        priority: body.priority ?? 0,
        triggerType: body.trigger_type,
        triggerConfig: body.trigger_config,
        steps: body.steps,
        source: body.source ?? "manual",
        contentMode: body.content_mode ?? "ai_drafted",
        status: "draft",
        approvalMode: body.approval_mode ?? (body.content_mode === "fixed_content" ? "auto" : "require"),
        flowClass: body.flow_class ?? "nurture",
        reentryPolicy: body.reentry_policy ?? "cooldown",
        reentryCooldownDays: body.reentry_cooldown_days ?? 30,
        promptSource: body.prompt_source ?? null,
        compiledPlan: null,
        compiledAt: null,
      })
      .returning();

    return c.json(serializeFlow(inserted!), 201);
  });

  /**
   * GET /v1/flows
   * List flows for the tenant. Excludes archived by default.
   * ?include_archived=true to include them.
   */
  r.get(
    "/",
    "member",
    async (c) => {
      const db: Db = c.var.db;
      const tenantId = c.var.tenant!.id;
      const includeArchived = c.req.query("include_archived") === "true";

      const rows = includeArchived
        ? await db
            .select()
            .from(flows)
            .where(eq(flows.tenantId, tenantId))
            .orderBy(flows.createdAt)
        : await db
            .select()
            .from(flows)
            .where(
              and(
                eq(flows.tenantId, tenantId),
                ne(flows.status, "archived"),
              ),
            )
            .orderBy(flows.createdAt);

      return c.json({ flows: rows.map(serializeFlow) });
    },
  );

  /**
   * GET /v1/flows/:id
   * Get a single flow. Returns 404 if not found or owned by another tenant.
   */
  r.get("/:id", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const rows = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, c.req.param("id")!), eq(flows.tenantId, tenantId)))
      .limit(1);

    if (rows.length === 0) {
      return c.json({ error: "Flow not found." }, 404);
    }

    return c.json(serializeFlow(rows[0]!));
  });

  /**
   * PATCH /v1/flows/:id
   * Partial update. Validates status transitions and prompt_source editability.
   *
   * Restrictions:
   *   - status transitions validated against FLOW_STATUS_TRANSITIONS
   *   - prompt_source is only editable when status is 'draft' or 'paused';
   *     editing it on an active flow returns 422 (pause the flow first)
   *   - compiled_plan and compiled_at are never accepted from the request body;
   *     they are owned by the compile worker (task 11)
   *   - if prompt_source changes and status allows it, compiled_plan and
   *     compiled_at are cleared (the old plan is stale)
   */
  r.patch(
    "/:id",
    "member",
    async (c) => {
      const parsed = updateFlowSchema.safeParse(c.var.body);
      if (!parsed.success) {
        return validationError(c, parsed.error.issues);
      }

      const body = parsed.data;
      const db: Db = c.var.db;
      const tenantId = c.var.tenant!.id;

      // Fetch current flow (tenant-scoped)
      const rows = await db
        .select()
        .from(flows)
        .where(and(eq(flows.id, c.req.param("id")!), eq(flows.tenantId, tenantId)))
        .limit(1);

      if (rows.length === 0) {
        return c.json({ error: "Flow not found." }, 404);
      }

      const current = rows[0]!;
      const currentStatus = current.status as FlowStatus;

      // Validate status transition if requested
      if (body.status !== undefined && body.status !== currentStatus) {
        const transitionError = validateStatusTransition(
          currentStatus,
          body.status as FlowStatus,
        );
        if (transitionError) {
          return c.json({ error: transitionError }, 422);
        }

        // [impl] Refuse activation without a compiled plan. A flow that is
        // active but has no compiled_plan cannot be executed by the enrollment
        // engine - contacts would be enrolled into an empty plan. Prevent the
        // invalid state at the API layer rather than tolerating it silently.
        if (body.status === "active") {
          if (current.compileStatus !== "ready" || current.compiledPlan === null) {
            return c.json({
              error:
                "Cannot activate a flow without a compiled plan. " +
                "Compile the flow first (POST /v1/flows/:id/compile) and wait for compile_status = 'ready'.",
            }, 422);
          }
        }
      }

      // prompt_source is only editable in draft or paused
      if (
        body.prompt_source !== undefined &&
        body.prompt_source !== current.promptSource
      ) {
        if (currentStatus !== "draft" && currentStatus !== "paused") {
          return c.json({
            error: `prompt_source cannot be edited while the flow is '${currentStatus}'. Pause the flow first.`,
          }, 422);
        }
      }

      // Validate step order uniqueness if steps are being updated
      if (body.steps !== undefined && body.steps.length > 0) {
        const orderError = validateStepOrders(body.steps);
        if (orderError) {
          return c.json({ error: orderError }, 400);
        }
      }

      // Build the SET clause; never include compiled_plan or compiled_at
      const setClauses: Record<string, unknown> = {
        updatedAt: new Date(),
      };

      if (body.name !== undefined)              setClauses.name = body.name;
      if (body.description !== undefined)       setClauses.description = body.description;
      if (body.priority !== undefined)          setClauses.priority = body.priority;
      if (body.trigger_type !== undefined)      setClauses.triggerType = body.trigger_type;
      if (body.trigger_config !== undefined)    setClauses.triggerConfig = body.trigger_config;
      if (body.steps !== undefined)             setClauses.steps = body.steps;
      if (body.source !== undefined)            setClauses.source = body.source;
      if (body.content_mode !== undefined)      setClauses.contentMode = body.content_mode;
      if (body.approval_mode !== undefined)     setClauses.approvalMode = body.approval_mode;
      if (body.flow_class !== undefined)        setClauses.flowClass = body.flow_class;
      if (body.reentry_policy !== undefined)    setClauses.reentryPolicy = body.reentry_policy;
      if (body.reentry_cooldown_days !== undefined) {
        setClauses.reentryCooldownDays = body.reentry_cooldown_days;
      }
      if (body.status !== undefined)            setClauses.status = body.status;

      // prompt_source: update and clear stale compiled_plan/compiled_at
      if (
        body.prompt_source !== undefined &&
        body.prompt_source !== current.promptSource
      ) {
        setClauses.promptSource = body.prompt_source;
        setClauses.compiledPlan = null;
        setClauses.compiledAt = null;
        setClauses.compileStatus = null;
        setClauses.compileError = null;
      }

      // CAS: when status is being changed, guard on current status to prevent
      // a concurrent PATCH from causing an invalid double-transition.
      const whereConditions = [
        eq(flows.id, c.req.param("id")!),
        eq(flows.tenantId, tenantId),
      ];
      if (body.status !== undefined && body.status !== currentStatus) {
        whereConditions.push(eq(flows.status, currentStatus));
      }

      const [updated] = await db
        .update(flows)
        .set(setClauses as any)
        .where(and(...whereConditions))
        .returning();

      if (!updated) {
        // CAS failed: status was changed by a concurrent request.
        return c.json({ error: "Flow status was modified concurrently. Retry the request." }, 409);
      }

      return c.json(serializeFlow(updated));
    },
  );

  /**
   * DELETE /v1/flows/:id
   * Archive a flow (sets status = 'archived'). Not a physical delete.
   *
   * The compiled_plan is preserved on archive: task 12 or an audit may want
   * to inspect what plan was running when the flow was archived.
   *
   * If the flow is already archived, this is a no-op (idempotent).
   * Returns 404 if the flow does not exist for this tenant.
   */
  r.delete("/:id", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    // Fetch current flow (tenant-scoped)
    const rows = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, c.req.param("id")!), eq(flows.tenantId, tenantId)))
      .limit(1);

    if (rows.length === 0) {
      return c.json({ error: "Flow not found." }, 404);
    }

    const current = rows[0]!;

    // Idempotent: already archived
    if (current.status === "archived") {
      return c.json(serializeFlow(current));
    }

    const [updated] = await db
      .update(flows)
      .set({ status: "archived", updatedAt: new Date() })
      .where(and(eq(flows.id, c.req.param("id")!), eq(flows.tenantId, tenantId)))
      .returning();

    return c.json(serializeFlow(updated!));
  });

  /**
   * POST /v1/flows/:id/compile
   * Enqueue a flow compilation job. Returns 202 Accepted.
   *
   * Preconditions:
   *   - Flow must exist for this tenant.
   *   - Flow must have a prompt_source (otherwise there is nothing to compile).
   *   - Flow must not be archived.
   *
   * The route sets compile_status = 'pending' and enqueues the job.
   * If a compile is already pending (singletonKey dedup), the enqueue is a
   * silent no-op and the route still returns 202 (idempotent).
   *
   * Returns 422 if preconditions are not met.
   * Returns 503 if the job queue is unavailable.
   */
  r.post("/:id/compile", "member", async (c) => {
    const db: Db = c.var.db;
    const enqueue = c.var.enqueue;
    const tenantId = c.var.tenant!.id;

    if (!enqueue) {
      return c.json({ error: "Job queue is not available." }, 503);
    }

    // Fetch flow
    const rows = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, c.req.param("id")!), eq(flows.tenantId, tenantId)))
      .limit(1);

    if (rows.length === 0) {
      return c.json({ error: "Flow not found." }, 404);
    }

    const flow = rows[0]!;

    // Precondition: not archived
    if (flow.status === "archived") {
      return c.json({ error: "Cannot compile an archived flow." }, 422);
    }

    // Precondition: has prompt_source
    if (!flow.promptSource) {
      return c.json({ error: "Flow has no prompt_source. Set a prompt before compiling." }, 422);
    }

    // Precondition: tenant has an active LLM configuration.
    // This is a user-resolvable error (go to Settings, add an LLM key), not an
    // async job failure. Check synchronously so the operator learns immediately.
    const llmRows = await db
      .select({ id: llmConfigs.id })
      .from(llmConfigs)
      .where(and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)))
      .limit(1);

    if (llmRows.length === 0) {
      return c.json({ error: "No LLM configuration found. Add an LLM provider in Settings before compiling flows." }, 422);
    }

    // Set compile_status = 'pending' and clear any previous error
    await db
      .update(flows)
      .set({
        compileStatus: "pending",
        compileError: null,
        updatedAt: new Date(),
      })
      .where(and(eq(flows.id, c.req.param("id")!), eq(flows.tenantId, tenantId)));

    // Enqueue the compile job. singletonKey ensures only one compile per flow.
    await enqueue(
      QUEUE.COMPILE,
      { flow_id: flow.id, tenant_id: tenantId },
      {
        singletonKey: flow.id,
        expireInMinutes: 10,
        retryLimit: 2,
        retryDelay: 30,
      },
    );

    return c.json({ message: "Compilation queued.", flow_id: flow.id, compile_status: "pending" }, 202);
  });
  /**
   * POST /v1/flows/:id/plan
   * Save a hand-authored compiled plan for a fixed_content flow.
   *
   * This is the path for person-written flows: the dashboard builds the
   * compiled plan from the step editor UI and submits it here. For each step
   * with email content, a template row is created/upserted, and template_ref
   * is set so the execution engine uses the deterministic template path.
   *
   * Body: { steps: Array<{ order, delay, action_type, window_policy, subject,
   *         body_html, body_text? }>, exit_conditions?: [...] }
   *
   * On success: creates templates, builds a compiled plan, sets
   * compile_status = "ready". The flow can then be activated.
   */
  r.post(
    "/:id/plan",
    "member",
    async (c) => {
      const db: Db = c.var.db;
      const tenantId = c.var.tenant!.id;

      // Validate request body
      const stepContentSchema = z.object({
        order: z.number().int().min(1),
        delay: z.string().regex(/^\d+(m|h|d)$/),
        action_type: z.string().min(1),
        window_policy: z.enum(["immediate", "respect_window"]),
        subject: z.string().min(1, "Subject is required"),
        body_html: z.string().min(1, "Body HTML is required"),
        body_text: z.string().optional(),
      });

      const planBodySchema = z.object({
        steps: z.array(stepContentSchema).min(1, "At least one step is required"),
        exit_conditions: z.array(z.unknown()).optional(),
      });

      const parsed = planBodySchema.safeParse(c.var.body);
      if (!parsed.success) {
        return c.json({
          error: "Invalid plan data.",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        }, 400);
      }

      const { steps, exit_conditions } = parsed.data;

      // Fetch flow
      const flowRows = await db
        .select()
        .from(flows)
        .where(and(eq(flows.id, c.req.param("id")!), eq(flows.tenantId, tenantId)))
        .limit(1);

      if (flowRows.length === 0) {
        return c.json({ error: "Flow not found." }, 404);
      }

      const flow = flowRows[0]!;

      if (flow.status === "archived") {
        return c.json({ error: "Cannot update the plan of an archived flow." }, 422);
      }

      if ((flow.contentMode ?? "ai_drafted") !== "fixed_content") {
        return c.json({
          error: "Only fixed_content flows accept a hand-authored plan. " +
            "AI-drafted flows use POST /v1/flows/:id/compile instead.",
        }, 422);
      }

      // Create/upsert templates for each step
      const flowId = c.req.param("id")!;
      const templateVariables = [
        "contact.first_name",
        "contact.name",
        "contact.email",
        "contact.company",
        "tenant.name",
      ];

      for (const step of steps) {
        const slug = `flow-${flowId}-step-${step.order}`;
        const name = `${flow.name} - Step ${step.order}`;

        // Upsert template: ON CONFLICT (tenant_id, slug) DO UPDATE
        await db
          .insert(templates)
          .values({
            tenantId,
            name,
            slug,
            subject: step.subject,
            bodyHtml: step.body_html,
            bodyText: step.body_text ?? null,
            variables: templateVariables,
            category: "flow",
            isActive: true,
          })
          .onConflictDoUpdate({
            target: [templates.tenantId, templates.slug],
            set: {
              name,
              subject: step.subject,
              bodyHtml: step.body_html,
              bodyText: step.body_text ?? null,
              variables: templateVariables,
              isActive: true,
            },
          });
      }

      // Build the compiled plan
      const compiledPlan = {
        trigger: {
          type: flow.triggerType,
          condition: flow.triggerConfig as Record<string, unknown>,
        },
        steps: steps.map((s) => ({
          order: s.order,
          action_type: s.action_type,
          delay: s.delay,
          window_policy: s.window_policy,
          template_ref: `flow-${flowId}-step-${s.order}`,
        })),
        ...(exit_conditions && exit_conditions.length > 0
          ? { exit_conditions }
          : {}),
      };

      // Validate against the schema to be sure
      const planParsed = compiledPlanSchema.safeParse(compiledPlan);
      if (!planParsed.success) {
        return c.json({
          error: "Internal error: generated plan failed validation.",
          issues: planParsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        }, 500);
      }

      // Write the plan to the flow
      const [updated] = await db
        .update(flows)
        .set({
          compiledPlan: planParsed.data as unknown as Record<string, unknown>,
          compiledAt: new Date(),
          compileStatus: "ready",
          compileError: null,
          steps: steps.map((s) => ({
            order: s.order,
            action_type: s.action_type,
            delay: s.delay,
            window_policy: s.window_policy,
            template_ref: `flow-${flowId}-step-${s.order}`,
          })),
          updatedAt: new Date(),
        })
        .where(and(eq(flows.id, flowId), eq(flows.tenantId, tenantId)))
        .returning();

      return c.json(serializeFlow(updated!));
    },
  );

  /**
   * POST /v1/flows/:id/draft-step
   * Ask the AI to draft copy for a single step in a fixed_content flow.
   *
   * The result is returned to the dashboard for the person to edit. It is
   * never stored automatically - the person owns the final copy.
   *
   * Body: { step_order: number, subject?: string, body_html?: string, context?: string }
   *   - step_order: which step to draft for (used for positioning context)
   *   - subject/body_html: existing content (if any) - the AI sees it as "current draft"
   *   - context: optional extra instructions from the person
   *
   * Returns: { subject: string, body_html: string }
   *
   * Requires an active LLM configuration.
   */
  r.post(
    "/:id/draft-step",
    "member",
    async (c) => {
      const db: Db = c.var.db;
      const tenantId = c.var.tenant!.id;

      const bodySchema = z.object({
        step_order: z.number().int().min(1),
        subject: z.string().optional(),
        body_html: z.string().optional(),
        context: z.string().optional(),
      });

      const parsed = bodySchema.safeParse(c.var.body);
      if (!parsed.success) {
        return validationError(c, parsed.error.issues);
      }

      const { step_order, subject, body_html, context } = parsed.data;

      // Fetch flow
      const flowRows = await db
        .select()
        .from(flows)
        .where(and(eq(flows.id, c.req.param("id")!), eq(flows.tenantId, tenantId)))
        .limit(1);

      if (flowRows.length === 0) {
        return c.json({ error: "Flow not found." }, 404);
      }

      const flow = flowRows[0]!;

      // Require active LLM config and resolve provider
      const llmRows = await db
        .select()
        .from(llmConfigs)
        .where(and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)))
        .limit(1);

      if (llmRows.length === 0) {
        return c.json({ error: "No LLM configuration found. Add an LLM provider in Settings to use AI drafting." }, 422);
      }

      const llmConfig = llmRows[0]!;
      const encryptionKeyEnv = process.env.ENCRYPTION_KEY;
      if (!encryptionKeyEnv) {
        return c.json({ error: "ENCRYPTION_KEY not configured." }, 500);
      }

      let provider;
      try {
        const key = parseEncryptionKey(encryptionKeyEnv);
        const decrypted = decrypt(llmConfig.config, key);
        const providerConfig = JSON.parse(decrypted);
        provider = new OpenAICompatibleProvider(providerConfig);
      } catch (err) {
        return c.json({ error: `Failed to resolve LLM provider: ${err instanceof Error ? err.message : String(err)}` }, 500);
      }

      // Fetch tenant name for product context
      const tenantRows = await db
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      const productName = tenantRows[0]?.name ?? undefined;

      // Build the steps array for context
      const compiledPlan = flow.compiledPlan as Record<string, unknown> | null;
      const steps = compiledPlan && Array.isArray(compiledPlan.steps)
        ? compiledPlan.steps as Array<Record<string, unknown>>
        : (Array.isArray(flow.steps) ? flow.steps as Array<Record<string, unknown>> : []);

      const currentStep = steps.find(
        (s) => typeof s.order === "number" && s.order === step_order,
      );
      const delay = currentStep?.delay as string | undefined;
      const actionType = currentStep?.action_type as string | undefined;

      // Build brain_instruction for the draft
      const parts: string[] = [];
      parts.push(`You are writing email step ${step_order} of ${steps.length || "a"} in a flow.`);
      if (flow.name) parts.push(`Flow name: "${flow.name}".`);
      if (flow.triggerType) parts.push(`Trigger: ${flow.triggerType} (${JSON.stringify(flow.triggerConfig)}).`);
      if (delay) parts.push(`This email sends ${delay === "0m" ? "immediately" : `after a ${delay} delay`}.`);
      if (actionType) parts.push(`Action type: ${actionType}.`);
      if (step_order > 1) parts.push(`This is a follow-up. The contact has already received ${step_order - 1} earlier email(s) in this flow.`);
      parts.push("Use {{contact.first_name|there}}, {{contact.name}}, {{contact.company}}, {{contact.email}} where personalisation belongs.");
      parts.push("The output must contain {{variable}} syntax for personalisation - do not use placeholder text like [Name].");
      if (subject) parts.push(`The person has written this subject so far: "${subject}". Improve or replace it.`);
      if (body_html) parts.push(`The person has written this body so far:\n${body_html}\nImprove or replace it.`);
      if (context) parts.push(`Additional instructions from the person: ${context}`);

      const brainInstruction = parts.join("\n");

      // Call the brain
      const result = await draft(provider, {
        brain_instruction: brainInstruction,
        action_type: actionType,
        product_name: productName,
        first_contact: step_order === 1,
      });

      if (!result.ok) {
        return c.json({ error: `AI draft failed: ${result.error}` }, 502);
      }

      // Convert markdown body to simple HTML (paragraphs)
      const bodyMarkdown = result.draft.body_markdown;
      const htmlBody = bodyMarkdown
        .split(/\n\n+/)
        .map((p: string) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
        .join("\n");

      return c.json({
        subject: result.draft.subject,
        body_html: htmlBody,
      });
    },
  );
  return r.app;
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Map a DB row to the API response shape.
 * Renames camelCase DB columns to snake_case for the wire format.
 * compiled_plan and compiled_at are included so the dashboard can show
 * compilation state.
 */
function serializeFlow(row: typeof flows.$inferSelect) {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    name: row.name,
    description: row.description,
    priority: row.priority,
    trigger_type: row.triggerType,
    trigger_config: row.triggerConfig,
    steps: row.steps,
    source: row.source,
    content_mode: row.contentMode ?? "ai_drafted",
    status: row.status,
    approval_mode: row.approvalMode,
    flow_class: row.flowClass,
    reentry_policy: row.reentryPolicy,
    reentry_cooldown_days: row.reentryCooldownDays,
    prompt_source: row.promptSource,
    compiled_plan: row.compiledPlan,
    compiled_at: row.compiledAt,
    compile_status: row.compileStatus,
    compile_error: row.compileError,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}
