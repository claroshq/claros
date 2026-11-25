/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/email-layouts.ts.
 */
import { and, desc, eq } from "drizzle-orm";
import { emailLayouts } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { EmailLayoutsQueries, EmailLayoutRow } from "../areas/email-layouts.js";

export function d1EmailLayouts(db: D1Db): EmailLayoutsQueries {
  const byId = (tenantId: string, id: string) => and(eq(emailLayouts.tenantId, tenantId), eq(emailLayouts.id, id));

  return {
    async listLayouts(tenantId) {
      return (await db
        .select()
        .from(emailLayouts)
        .where(eq(emailLayouts.tenantId, tenantId))
        .orderBy(desc(emailLayouts.updatedAt))) as EmailLayoutRow[];
    },

    async getLayout({ tenantId, id }) {
      const rows = await db.select().from(emailLayouts).where(byId(tenantId, id)).limit(1);
      return (rows[0] as EmailLayoutRow | undefined) ?? null;
    },

    async createLayout({ tenantId, name, description, width, source, basedOn, now }) {
      const row = { id: crypto.randomUUID(), tenantId, name, description, width, source, basedOn, createdAt: now, updatedAt: now };
      await db.insert(emailLayouts).values(row);
      return row;
    },

    async updateLayout({ tenantId, id, patch, now }) {
      const set: Record<string, unknown> = { updatedAt: now };
      for (const k of ["name", "description", "width", "source"] as const) if (patch[k] !== undefined) set[k] = patch[k];
      const rows = await db.update(emailLayouts).set(set).where(byId(tenantId, id)).returning();
      return (rows[0] as EmailLayoutRow | undefined) ?? null;
    },

    async deleteLayout({ tenantId, id }) {
      const rows = await db.delete(emailLayouts).where(byId(tenantId, id)).returning({ id: emailLayouts.id });
      return rows.length > 0;
    },
  };
}
