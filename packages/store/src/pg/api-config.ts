/**
 * Postgres implementation of ../areas/api-config.ts. The apply runs in one
 * transaction that locks the tenant row (SELECT ... FOR UPDATE) and checks
 * config_version first.
 */
import { and, eq, sql } from "drizzle-orm";
import { tenants, topics, contactTopics, templates, flows, transportConfigs, webhookEndpoints, webhookOutbox, llmConfigs } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import { pgReindexContactDates } from "./contact-dates.js";
import type { ApiConfigQueries } from "../areas/api-config.js";

export function pgApiConfig(db: PgDb): ApiConfigQueries {
  return {
    reindexContactDates({ tenantId, properties, now }) {
      return pgReindexContactDates(db, tenantId, properties, now);
    },

    async loadConfigState(tenantId) {
      const [t] = await db
        .select({ settings: tenants.settings, locale: tenants.locale, configVersion: tenants.configVersion })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      if (!t) return null;
      const [tp, tm, fl, tr, ep] = await Promise.all([
        db.select().from(topics).where(eq(topics.tenantId, tenantId)),
        db.select().from(templates).where(eq(templates.tenantId, tenantId)),
        db.select().from(flows).where(eq(flows.tenantId, tenantId)),
        db.select().from(transportConfigs).where(eq(transportConfigs.tenantId, tenantId)),
        db.select().from(webhookEndpoints).where(eq(webhookEndpoints.tenantId, tenantId)),
      ]);
      const llm = await db.select({ id: llmConfigs.id }).from(llmConfigs).where(and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true))).limit(1);
      return {
        hasLlm: llm.length > 0,
        settings: (t.settings as Record<string, unknown> | null) ?? {},
        locale: t.locale,
        configVersion: t.configVersion,
        topics: tp.map((x) => ({ id: x.id, slug: x.slug, name: x.name, kind: x.kind, description: x.description, defaultSubscribed: x.defaultSubscribed, mirrorOnly: x.mirrorOnly })),
        templates: tm.map((x) => ({ id: x.id, slug: x.slug, name: x.name, subject: x.subject, bodyHtml: x.bodyHtml, bodyText: x.bodyText, category: x.category, isActive: x.isActive })),
        flows: fl.map((x) => ({
          id: x.id, slug: x.slug, name: x.name, description: x.description, status: x.status, triggerType: x.triggerType,
          triggerConfig: x.triggerConfig, steps: x.steps, compiledPlan: x.compiledPlan, promptSource: x.promptSource,
          contentMode: x.contentMode, approvalMode: x.approvalMode, flowClass: x.flowClass, priority: x.priority,
          reentryPolicy: x.reentryPolicy, reentryCooldownDays: x.reentryCooldownDays, topicId: x.topicId,
        })),
        transports: tr.map((x) => ({ id: x.id, name: x.name, kind: x.kind ?? x.provider, isActive: x.isActive !== false })),
        endpoints: ep.map((x) => ({ id: x.id, slug: x.slug, kind: x.kind, url: x.url, events: x.events ?? [], enabled: x.enabled, secret: x.secret, config: (x.config as Record<string, unknown> | null) ?? null })),
      };
    },

    async applyConfigOps({ tenantId, ops, expectedVersion, now }) {
      return db.transaction(async (txh) => {
        const tx = txh as unknown as PgDb;
        const locked = await tx.execute<{ config_version: number; settings: Record<string, unknown> | null }>(sql`
          SELECT config_version, settings FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE
        `);
        const row = locked.rows[0];
        if (!row || Number(row.config_version) !== expectedVersion) return { ok: false as const, conflict: true as const };
        let settings: Record<string, unknown> | null = null;
        let locale: { value: string | null } | null = null;
        for (const op of ops) {
          switch (op.op) {
            case "upsertTopic":
              if (op.create) await tx.insert(topics).values({ id: op.id, tenantId, ...op.values, createdAt: now });
              else await tx.update(topics).set(op.values).where(and(eq(topics.id, op.id), eq(topics.tenantId, tenantId)));
              break;
            case "deleteTopic":
              await tx.delete(contactTopics).where(and(eq(contactTopics.topicId, op.id), eq(contactTopics.tenantId, tenantId)));
              await tx.delete(topics).where(and(eq(topics.id, op.id), eq(topics.tenantId, tenantId)));
              break;
            case "upsertTemplate":
              if (op.create) await tx.insert(templates).values({ id: op.id, tenantId, ...op.values, isActive: true, createdAt: now });
              else await tx.update(templates).set({ ...op.values, isActive: true }).where(and(eq(templates.id, op.id), eq(templates.tenantId, tenantId)));
              break;
            case "deleteTemplate":
              await tx.delete(templates).where(and(eq(templates.id, op.id), eq(templates.tenantId, tenantId)));
              break;
            case "upsertFlow": {
              const v = op.values;
              const compile =
                v.compileStatus === "ready"
                  ? { compiledPlan: v.compiledPlan, compileStatus: "ready", compiledAt: now, compileError: null }
                  : v.compileStatus === "pending"
                    ? { compiledPlan: null, compileStatus: null, compiledAt: null, compileError: null }
                    : {};
              const fields = {
                slug: v.slug, name: v.name, description: v.description, status: v.status, triggerType: v.triggerType,
                triggerConfig: v.triggerConfig, steps: v.steps, promptSource: v.promptSource, contentMode: v.contentMode,
                approvalMode: v.approvalMode, flowClass: v.flowClass, priority: v.priority, reentryPolicy: v.reentryPolicy,
                reentryCooldownDays: v.reentryCooldownDays, topicId: v.topicId, updatedAt: now, ...compile,
              };
              if (op.create) await tx.insert(flows).values({ id: op.id, tenantId, source: "config", createdAt: now, ...fields });
              else await tx.update(flows).set(fields).where(and(eq(flows.id, op.id), eq(flows.tenantId, tenantId)));
              break;
            }
            case "archiveFlow":
              await tx.update(flows).set({ status: "archived", slug: null, updatedAt: now }).where(and(eq(flows.id, op.id), eq(flows.tenantId, tenantId)));
              break;
            case "upsertEndpoint": {
              const fields = { ...op.values, updatedAt: now, ...(op.secret !== undefined ? { secret: op.secret } : {}) };
              if (op.create) await tx.insert(webhookEndpoints).values({ id: op.id, tenantId, createdAt: now, ...fields });
              else await tx.update(webhookEndpoints).set(fields).where(and(eq(webhookEndpoints.id, op.id), eq(webhookEndpoints.tenantId, tenantId)));
              break;
            }
            case "deleteEndpoint":
              await tx.delete(webhookOutbox).where(and(eq(webhookOutbox.endpointId, op.id), eq(webhookOutbox.tenantId, tenantId), eq(webhookOutbox.status, "pending")));
              await tx.delete(webhookEndpoints).where(and(eq(webhookEndpoints.id, op.id), eq(webhookEndpoints.tenantId, tenantId)));
              break;
            case "setSettings": {
              const next: Record<string, unknown> = { ...(settings ?? row.settings ?? {}) };
              for (const [k, v] of Object.entries(op.patch)) {
                if (v === null) delete next[k];
                else next[k] = v;
              }
              settings = next;
              break;
            }
            case "setLocale":
              locale = { value: op.locale };
              break;
          }
        }
        const bumped = await tx
          .update(tenants)
          .set({
            configVersion: sql`${tenants.configVersion} + 1`,
            ...(settings !== null ? { settings } : {}),
            ...(locale !== null ? { locale: locale.value } : {}),
          })
          .where(eq(tenants.id, tenantId))
          .returning({ configVersion: tenants.configVersion });
        return { ok: true as const, configVersion: bumped[0]!.configVersion };
      });
    },
  };
}
