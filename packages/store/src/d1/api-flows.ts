/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-flows.ts.
 *
 * Same Drizzle queries as the Postgres module on the sqlite-core schema.
 * updateFlow's CAS on status is one UPDATE ... WHERE status = ? RETURNING,
 * atomic on SQLite.
 */
import { eq, and, ne, gt, inArray } from "drizzle-orm";
import { contacts, flows, llmConfigs, tenants, templates } from "@claros/db/schema-sqlite";
import { d1ContactConditions } from "./contact-conditions.js";
import type { D1Db } from "./db.js";
import type { ApiFlowsQueries } from "../areas/api-flows.js";

export function d1ApiFlows(db: D1Db): ApiFlowsQueries {
  return {
    ...d1ContactConditions(db),

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
      const [inserted] = await db.insert(flows).values(values).returning();
      return inserted;
    },

    async listFlows({ tenantId, includeArchived }) {
      const where = includeArchived
        ? eq(flows.tenantId, tenantId)
        : and(eq(flows.tenantId, tenantId), ne(flows.status, "archived"));
      return db.select().from(flows).where(where).orderBy(flows.createdAt);
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
      const whereConditions = [eq(flows.id, id), eq(flows.tenantId, tenantId)];
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
      const rows = await db
        .select({ id: llmConfigs.id })
        .from(llmConfigs)
        .where(and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)))
        .limit(1);
      return rows.length > 0;
    },

    async markCompilePending({ tenantId, id, now }) {
      await db
        .update(flows)
        .set({ compileStatus: "pending", compileError: null, updatedAt: now })
        .where(and(eq(flows.id, id), eq(flows.tenantId, tenantId)));
    },

    async upsertStepTemplate({ tenantId, name, slug, subject, bodyHtml, bodyText, variables }) {
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
          set: { name, subject, bodyHtml, bodyText, variables, isActive: true },
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
      const rows = await db
        .select({ config: llmConfigs.config })
        .from(llmConfigs)
        .where(and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)))
        .limit(1);
      const row = rows[0];
      return row ? { config: row.config } : null;
    },

    async findTenantName(tenantId) {
      const rows = await db
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return rows[0]?.name ?? null;
    },
  };
}
