/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-settings.ts.
 *
 * transport_configs.config holds the encrypted envelope as JSON text; it is
 * written through json() (validated like ::jsonb) and read back as text.
 */
import { eq, and, asc, sql } from "drizzle-orm";
import { transportConfigs, llmConfigs, tenants } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiSettingsQueries, SettingsSendTransportRow } from "../areas/api-settings.js";

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

const TRANSPORT_DETAIL_COLUMNS = {
  ...TRANSPORT_DISPLAY_COLUMNS,
  kind: sql<string>`COALESCE(${transportConfigs.kind}, ${transportConfigs.provider})`,
  name: transportConfigs.name,
  replyTo: transportConfigs.replyTo,
} as const;

export function d1ApiSettings(db: D1Db): ApiSettingsQueries {
  return {
    async deactivateActiveTransportConfigs(tenantId) {
      await db
        .update(transportConfigs)
        .set({ isActive: false })
        .where(and(eq(transportConfigs.tenantId, tenantId), eq(transportConfigs.isActive, true)));
    },

    async insertActiveTransportConfig(input) {
      const [inserted] = await db
        .insert(transportConfigs)
        .values({
          tenantId: input.tenantId,
          provider: input.provider,
          kind: input.provider,
          config: sql`json(${input.encryptedConfig})`,
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
        .where(and(eq(transportConfigs.tenantId, tenantId), eq(transportConfigs.isActive, true)))
        .orderBy(asc(transportConfigs.createdAt), asc(transportConfigs.id))
        .limit(1);
      return rows[0] ?? null;
    },

    async deactivateActiveLlmConfigs(tenantId) {
      await db
        .update(llmConfigs)
        .set({ isActive: false })
        .where(and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)));
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
        .where(and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)))
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
      const rows = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return rows[0] ?? null;
    },

    async updateTenantSettings(tenantId, settings) {
      await db.update(tenants).set({ settings }).where(eq(tenants.id, tenantId));
    },

    async findTenantNameAndSettings(tenantId) {
      const rows = await db
        .select({ name: tenants.name, settings: tenants.settings, publicHost: tenants.publicHost })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return rows[0] ?? null;
    },

    async findActiveTransportForSend(tenantId) {
      const rows = await db.all<SettingsSendTransportRow>(sql`
        SELECT provider, config, from_email, from_name
        FROM transport_configs
        WHERE tenant_id = ${tenantId}
          AND is_active = 1
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `);
      return rows[0] ?? null;
    },

    async listActiveTransports(tenantId) {
      return db
        .select(TRANSPORT_DETAIL_COLUMNS)
        .from(transportConfigs)
        .where(and(eq(transportConfigs.tenantId, tenantId), eq(transportConfigs.isActive, true)))
        .orderBy(asc(transportConfigs.createdAt), asc(transportConfigs.id));
    },

    async findActiveTransport({ tenantId, id }) {
      const rows = await db
        .select({ ...TRANSPORT_DETAIL_COLUMNS, config: sql<string>`${sql.identifier("config")}` })
        .from(transportConfigs)
        .where(
          and(
            eq(transportConfigs.tenantId, tenantId),
            eq(transportConfigs.id, id),
            eq(transportConfigs.isActive, true),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async insertTransport(input) {
      const [inserted] = await db
        .insert(transportConfigs)
        .values({
          tenantId: input.tenantId,
          // provider mirrors kind so code that reads provider keeps working.
          provider: input.kind,
          kind: input.kind,
          name: input.name,
          config: sql`json(${input.encryptedConfig})`,
          isActive: true,
          fromEmail: input.fromEmail,
          fromName: input.fromName,
          replyTo: input.replyTo,
          dailyLimit: input.dailyLimit,
        })
        .returning(TRANSPORT_DETAIL_COLUMNS);
      return inserted;
    },

    async updateTransport({ tenantId, id, patch }) {
      const set: Record<string, unknown> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.fromEmail !== undefined) set.fromEmail = patch.fromEmail;
      if (patch.fromName !== undefined) set.fromName = patch.fromName;
      if (patch.replyTo !== undefined) set.replyTo = patch.replyTo;
      if (patch.dailyLimit !== undefined) set.dailyLimit = patch.dailyLimit;
      if (patch.encryptedConfig !== undefined) set.config = sql`json(${patch.encryptedConfig})`;
      const where = and(
        eq(transportConfigs.tenantId, tenantId),
        eq(transportConfigs.id, id),
        eq(transportConfigs.isActive, true),
      );
      if (Object.keys(set).length === 0) {
        const rows = await db.select(TRANSPORT_DETAIL_COLUMNS).from(transportConfigs).where(where).limit(1);
        return rows[0] ?? null;
      }
      const rows = await db
        .update(transportConfigs)
        .set(set as never)
        .where(where)
        .returning(TRANSPORT_DETAIL_COLUMNS);
      return rows[0] ?? null;
    },

    async deactivateTransport({ tenantId, id }) {
      const rows = await db
        .update(transportConfigs)
        .set({ isActive: false })
        .where(
          and(
            eq(transportConfigs.tenantId, tenantId),
            eq(transportConfigs.id, id),
            eq(transportConfigs.isActive, true),
          ),
        )
        .returning({ id: transportConfigs.id });
      return rows.length > 0;
    },
  };
}
