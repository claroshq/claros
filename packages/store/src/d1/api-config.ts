/**
 * SQLite / D1 implementation of ../areas/api-config.ts.
 *
 * The apply is one db.batch() (one transaction): its first statement bumps
 * config_version guarded by the expected version (and writes the merged
 * settings), the second aborts the batch when that guard matched no row
 * (an INSERT that violates NOT NULL, guarded by changes() = 0), so a stale
 * apply writes nothing. Settings are merged in JS from the state read at
 * plan time; a settings write by another route between that read and the
 * apply is overwritten for the keys the document sets (other keys kept as
 * read). Postgres merges under a row lock instead.
 */
import { and, eq, sql } from "drizzle-orm";
import { tenants, topics, contactTopics, templates, flows, transportConfigs, webhookEndpoints, webhookOutbox, llmConfigs } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import { d1ReindexContactDates } from "./contact-dates.js";
import type { ApiConfigQueries } from "../areas/api-config.js";

export function d1ApiConfig(db: D1Db): ApiConfigQueries {
  return {
    reindexContactDates({ tenantId, properties, now }) {
      return d1ReindexContactDates(db, tenantId, properties, now);
    },

    async loadConfigState(tenantId) {
      const [t] = await db
        .select({ settings: tenants.settings, locale: tenants.locale, configVersion: tenants.configVersion })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      if (!t) return null;
      const [tp, tm, fl, tr, ep] = await db.batch([
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
        topics: tp.map((x) => ({ id: x.id, slug: x.slug, name: x.name, kind: x.kind, description: x.description, defaultSubscribed: x.defaultSubscribed })),
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
      const [t] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId));
      if (!t) return { ok: false, conflict: true };
      let settings: Record<string, unknown> | null = null;
      let locale: { value: string | null } | null = null;
      const statements: unknown[] = [];
      for (const op of ops) {
        switch (op.op) {
          case "upsertTopic":
            statements.push(
              op.create
                ? db.insert(topics).values({ id: op.id, tenantId, ...op.values, createdAt: now })
                : db.update(topics).set(op.values).where(and(eq(topics.id, op.id), eq(topics.tenantId, tenantId))),
            );
            break;
          case "deleteTopic":
            statements.push(db.delete(contactTopics).where(and(eq(contactTopics.topicId, op.id), eq(contactTopics.tenantId, tenantId))));
            statements.push(db.delete(topics).where(and(eq(topics.id, op.id), eq(topics.tenantId, tenantId))));
            break;
          case "upsertTemplate":
            statements.push(
              op.create
                ? db.insert(templates).values({ id: op.id, tenantId, ...op.values, isActive: true, createdAt: now })
                : db.update(templates).set({ ...op.values, isActive: true }).where(and(eq(templates.id, op.id), eq(templates.tenantId, tenantId))),
            );
            break;
          case "deleteTemplate":
            statements.push(db.delete(templates).where(and(eq(templates.id, op.id), eq(templates.tenantId, tenantId))));
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
            statements.push(
              op.create
                ? db.insert(flows).values({ id: op.id, tenantId, source: "config", createdAt: now, ...fields })
                : db.update(flows).set(fields).where(and(eq(flows.id, op.id), eq(flows.tenantId, tenantId))),
            );
            break;
          }
          case "archiveFlow":
            statements.push(db.update(flows).set({ status: "archived", slug: null, updatedAt: now }).where(and(eq(flows.id, op.id), eq(flows.tenantId, tenantId))));
            break;
          case "upsertEndpoint": {
            const fields = { ...op.values, updatedAt: now, ...(op.secret !== undefined ? { secret: op.secret } : {}) };
            statements.push(
              op.create
                ? db.insert(webhookEndpoints).values({ id: op.id, tenantId, createdAt: now, ...fields })
                : db.update(webhookEndpoints).set(fields).where(and(eq(webhookEndpoints.id, op.id), eq(webhookEndpoints.tenantId, tenantId))),
            );
            break;
          }
          case "deleteEndpoint":
            statements.push(db.delete(webhookOutbox).where(and(eq(webhookOutbox.endpointId, op.id), eq(webhookOutbox.tenantId, tenantId), eq(webhookOutbox.status, "pending"))));
            statements.push(db.delete(webhookEndpoints).where(and(eq(webhookEndpoints.id, op.id), eq(webhookEndpoints.tenantId, tenantId))));
            break;
          case "setSettings": {
            const next: Record<string, unknown> = { ...(settings ?? (t.settings as Record<string, unknown> | null) ?? {}) };
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
      const bump = db
        .update(tenants)
        .set({
          configVersion: sql`${tenants.configVersion} + 1`,
          ...(settings !== null ? { settings } : {}),
          ...(locale !== null ? { locale: locale.value } : {}),
        })
        .where(and(eq(tenants.id, tenantId), eq(tenants.configVersion, expectedVersion)))
        .returning({ configVersion: tenants.configVersion });
      // Aborts the whole batch when the guarded bump matched nothing.
      const abortIfStale = db.insert(tenants).select(sql`
        SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL WHERE changes() = 0
      `);
      try {
        const [bumped] = (await db.batch([bump, abortIfStale, ...statements] as never)) as Array<Array<{ configVersion: number }>>;
        return { ok: true, configVersion: bumped![0]!.configVersion };
      } catch (err) {
        const [cur] = await db.select({ v: tenants.configVersion }).from(tenants).where(eq(tenants.id, tenantId));
        if (!cur || cur.v !== expectedVersion) return { ok: false, conflict: true };
        throw err;
      }
    },
  };
}
