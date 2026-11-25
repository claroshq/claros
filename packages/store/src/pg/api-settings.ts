/**
 * Postgres implementation of the queries used by packages/api/src/routes/settings.ts.
 */
import { eq, and, sql } from "drizzle-orm";
import { transportConfigs, llmConfigs, tenants } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiSettingsQueries } from "../areas/api-settings.js";

const TRANSPORT_DISPLAY_COLUMNS = {
  id: transportConfigs.id,
  provider: transportConfigs.provider,
  fromEmail: transportConfigs.fromEmail,
  fromName: transportConfigs.fromName,
  dailyLimit: transportConfigs.dailyLimit,
  dkimVerified: transportConfigs.dkimVerified,
  isActive: transportConfigs.isActive,
  createdAt: transportConfigs.createdAt,
} as const;

export function pgApiSettings(db: PgDb): ApiSettingsQueries {
  return {
    async deactivateActiveTransportConfigs(tenantId) {
      await db
        .update(transportConfigs)
        .set({ isActive: false })
        .where(
          and(eq(transportConfigs.tenantId, tenantId), eq(transportConfigs.isActive, true)),
        );
    },

    async insertActiveTransportConfig(input) {
      const [inserted] = await db
        .insert(transportConfigs)
        .values({
          tenantId: input.tenantId,
          provider: input.provider,
          config: sql`${input.encryptedConfig}::jsonb`,
          isActive: true,
          fromEmail: input.fromEmail,
          fromName: input.fromName,
          dailyLimit: input.dailyLimit,
        })
        .returning(TRANSPORT_DISPLAY_COLUMNS);
      return inserted;
    },

    async findActiveTransportConfig(tenantId) {
      const rows = await db
        .select(TRANSPORT_DISPLAY_COLUMNS)
        .from(transportConfigs)
        .where(
          and(eq(transportConfigs.tenantId, tenantId), eq(transportConfigs.isActive, true)),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async deactivateActiveLlmConfigs(tenantId) {
      await db
        .update(llmConfigs)
        .set({ isActive: false })
        .where(
          and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)),
        );
    },

    async insertActiveLlmConfig(input) {
      const [inserted] = await db
        .insert(llmConfigs)
        .values({
          tenantId: input.tenantId,
          provider: input.provider,
          config: input.encryptedConfig,
          isActive: true,
        })
        .returning({
          id: llmConfigs.id,
          provider: llmConfigs.provider,
          isActive: llmConfigs.isActive,
          createdAt: llmConfigs.createdAt,
        });
      return inserted;
    },

    async findActiveLlmConfig(tenantId) {
      const rows = await db
        .select({
          id: llmConfigs.id,
          provider: llmConfigs.provider,
          config: llmConfigs.config,
          isActive: llmConfigs.isActive,
          createdAt: llmConfigs.createdAt,
        })
        .from(llmConfigs)
        .where(
          and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async findTenant(tenantId) {
      const rows = await db
        .select({
          id: tenants.id,
          name: tenants.name,
          slug: tenants.slug,
          plan: tenants.plan,
          settings: tenants.settings,
          createdAt: tenants.createdAt,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return rows[0] ?? null;
    },

    async findTenantSettings(tenantId) {
      const tenantRows = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return tenantRows[0] ?? null;
    },

    async updateTenantSettings(tenantId, settings) {
      await db.update(tenants).set({ settings }).where(eq(tenants.id, tenantId));
    },

    async findTenantNameAndSettings(tenantId) {
      const tenantRows = await db
        .select({ name: tenants.name, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return tenantRows[0] ?? null;
    },

    async findActiveTransportForSend(tenantId) {
      const configRows = await db.execute<{
        provider: string;
        config: string;
        from_email: string;
        from_name: string | null;
      }>(sql`
        SELECT provider, config::text AS config, from_email, from_name
        FROM transport_configs
        WHERE tenant_id = ${tenantId}::uuid
          AND is_active = true
        LIMIT 1
      `);
      return configRows.rows[0] ?? null;
    },
  };
}
