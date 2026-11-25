/**
 * Postgres implementation of the queries used by packages/api/src/routes/flows.ts.
 */
import { eq, and, ne, gt, inArray } from "drizzle-orm";
import { contacts, flows, llmConfigs, tenants, templates } from "@claros/db/schema";
import { pgContactConditions } from "./contact-conditions.js";
import type { PgDb } from "./db.js";
import type { ApiFlowsQueries } from "../areas/api-flows.js";

export function pgApiFlows(db: PgDb): ApiFlowsQueries {
  return {
    ...pgContactConditions(db),

    async listContactIdsPage({ tenantId, afterId, limit }) {
      const rows = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.tenantId, tenantId), afterId === null ? undefined : gt(contacts.id, afterId)))
        .orderBy(contacts.id)
        .limit(limit);
      return rows.map((r) => r.id);
    },

    async findContactsByExternalIds({ tenantId, externalIds }) {
      const out: Array<{ id: string; externalId: string }> = [];
      // Chunks keep D1 under its 100 bound parameters per statement.
      for (let i = 0; i < externalIds.length; i += 90) {
        out.push(
          ...(await db
            .select({ id: contacts.id, externalId: contacts.externalId })
            .from(contacts)
            .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.externalId, externalIds.slice(i, i + 90))))),
        );
      }
      return out;
    },


    async createFlow(values) {
      const [inserted] = await db
        .insert(flows)
        .values(values)
        .returning();
      return inserted;
    },

    async listFlows({ tenantId, includeArchived }) {
      return includeArchived
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
    },

    async findFlow({ tenantId, id }) {
      const rows = await db
        .select()
        .from(flows)
        .where(and(eq(flows.id, id), eq(flows.tenantId, tenantId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async updateFlow({ tenantId, id, patch, expectedStatus }) {
      // CAS: when status is being changed, guard on current status to prevent
      // a concurrent PATCH from causing an invalid double-transition.
      const whereConditions = [
        eq(flows.id, id),
        eq(flows.tenantId, tenantId),
      ];
      if (expectedStatus !== undefined) {
        whereConditions.push(eq(flows.status, expectedStatus));
      }

      const [updated] = await db
        .update(flows)
        .set(patch as any)
        .where(and(...whereConditions))
        .returning();
      return updated ?? null;
    },

    async archiveFlow({ tenantId, id, now }) {
      const [updated] = await db
        .update(flows)
        .set({ status: "archived", updatedAt: now })
        .where(and(eq(flows.id, id), eq(flows.tenantId, tenantId)))
        .returning();
      return updated;
    },

    async hasActiveLlmConfig(tenantId) {
      const llmRows = await db
        .select({ id: llmConfigs.id })
        .from(llmConfigs)
        .where(and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)))
        .limit(1);
      return llmRows.length > 0;
    },

    async markCompilePending({ tenantId, id, now }) {
      await db
        .update(flows)
        .set({
          compileStatus: "pending",
          compileError: null,
          updatedAt: now,
        })
        .where(and(eq(flows.id, id), eq(flows.tenantId, tenantId)));
    },

    async upsertStepTemplate({ tenantId, name, slug, subject, bodyHtml, bodyText, variables }) {
      // Upsert template: ON CONFLICT (tenant_id, slug) DO UPDATE
      await db
        .insert(templates)
        .values({
          tenantId,
          name,
          slug,
          subject,
          bodyHtml,
          bodyText,
          variables,
          category: "flow",
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [templates.tenantId, templates.slug],
          set: {
            name,
            subject,
            bodyHtml,
            bodyText,
            variables,
            isActive: true,
          },
        });
    },

    async saveFixedPlan({ tenantId, id, compiledPlan, steps, compiledAt, updatedAt }) {
      const [updated] = await db
        .update(flows)
        .set({
          compiledPlan,
          compiledAt,
          compileStatus: "ready",
          compileError: null,
          steps,
          updatedAt,
        })
        .where(and(eq(flows.id, id), eq(flows.tenantId, tenantId)))
        .returning();
      return updated;
    },

    async findActiveLlmConfig(tenantId) {
      const llmRows = await db
        .select()
        .from(llmConfigs)
        .where(and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)))
        .limit(1);
      const row = llmRows[0];
      return row ? { config: row.config } : null;
    },

    async findTenantName(tenantId) {
      const tenantRows = await db
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return tenantRows[0]?.name ?? null;
    },
  };
}
