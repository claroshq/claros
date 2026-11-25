/**
 * Compile worker handler - processes flow compilation jobs.
 *
 * Job flow:
 * 1. Read the flow row (tenant-scoped).
 * 2. Check compile_status is still 'pending' (CAS guard).
 * 3. Resolve the tenant's LLM provider via resolveTenantProvider().
 * 4. Resolve available @template and @kb references for the prompt context.
 * 5. Call compile() from brain-oss.
 * 6. On success: write compiled_plan, compiled_at, compile_status = 'ready'.
 * 7. On failure: write compile_status = 'failed', compile_error.
 *
 * CAS semantics: the worker only writes if compile_status is still 'pending'.
 * If the prompt changed while the job was in flight (status reset to null by
 * the API), the write returns 0 rows and the stale result is discarded.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor } from "@claros/store";
import {
  compile,
  type CompilePromptContext,
} from "@claros/brain-oss";
import type { CompileJobData } from "@claros/core";
import { resolveTenantProvider } from "./provider-resolver.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleCompileJob(
  data: CompileJobData,
  db: Db,
): Promise<void> {
  const { flow_id, tenant_id } = data;

  // 1. Read the flow row
  const flow = await storeFor(db).workerCompile.getFlow(tenant_id, flow_id);

  if (flow === null) {
    console.warn(`[compile] flow ${flow_id} not found for tenant ${tenant_id}, skipping`);
    return;
  }


  // 2. CAS guard: only proceed if compile_status is still 'pending'
  if (flow.compileStatus !== "pending") {
    console.warn(`[compile] flow ${flow_id} compile_status is '${flow.compileStatus}', expected 'pending', skipping`);
    return;
  }

  // 3. Check prompt_source exists
  if (!flow.promptSource) {
    await markFailed(db, flow_id, "Flow has no prompt_source to compile.");
    return;
  }

  // 4. Resolve the tenant's LLM provider (DB lookup + decrypt)
  const providerResult = await resolveTenantProvider(db, tenant_id);
  if (!providerResult.ok) {
    await markFailed(db, flow_id, providerResult.reason);
    return;
  }
  const { provider } = providerResult;

  // 5. Resolve available templates and KB entries for the prompt context
  const [templateSlugs, kbTitles] = await Promise.all([
    storeFor(db).workerCompile.listActiveTemplateSlugs(tenant_id),
    storeFor(db).workerCompile.listActiveKbTitles(tenant_id),
  ]);

  const ctx: CompilePromptContext = {
    promptSource: flow.promptSource,
    triggerType: flow.triggerType,
    triggerConfig: flow.triggerConfig as Record<string, unknown>,
    availableTemplates: templateSlugs,
    availableKbEntries: kbTitles,
  };

  // 6. Call compile
  const result = await compile(provider, ctx);

  // 7. Write result with CAS (only if still pending)
  if (result.ok) {
    const won = await storeFor(db).workerCompile.markCompileReady(flow_id, result.plan);

    if (!won) {
      console.warn(`[compile] flow ${flow_id} CAS failed on success write (status changed), discarding result`);
    }
  } else {
    const won = await storeFor(db).workerCompile.markCompileFailed(
      flow_id,
      result.error.slice(0, 2000), // truncate to reasonable length
    );

    if (!won) {
      console.warn(`[compile] flow ${flow_id} CAS failed on error write (status changed), discarding`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mark a flow's compilation as failed. Used for pre-LLM failures (missing config, etc.).
 * Also uses CAS on compile_status = 'pending'.
 */
async function markFailed(db: Db, flowId: string, error: string): Promise<void> {
  await storeFor(db).workerCompile.markCompileFailed(flowId, error.slice(0, 2000));
}
