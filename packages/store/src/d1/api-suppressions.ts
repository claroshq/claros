/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-suppressions.ts.
 *
 * - Inserts are INSERT ... SELECT ... WHERE NOT EXISTS (one statement, atomic
 *   on SQLite; D1 serialises writes); the unique index
 *   uq_suppressions_tenant_email_lower (migration 0003) also enforces it. SQLite lower()
 *   folds ASCII only, Postgres lower() folds all of Unicode.
 * - importSuppressions: within-batch case-insensitive duplicates are dropped
 *   in JS (first occurrence wins, as with Postgres ON CONFLICT), the rest is
 *   inserted in chunks under D1's bound-parameter limit, run as one batch.
 * - listSuppressions: created_at is integer ms, so date_trunc('milliseconds')
 *   is the column itself.
 */
import { eq, and, sql } from "drizzle-orm";
import { suppressions } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiSuppressionsQueries } from "../areas/api-suppressions.js";
import { d1OutboxEndpoints, d1OutboxInserts } from "./outbox.js";

/** Rows per INSERT: 2 params per row + 3 shared stays under 100. */
const IMPORT_CHUNK = 45;

export function d1ApiSuppressions(db: D1Db): ApiSuppressionsQueries {
  return {
    async addManualSuppression({ tenantId, email }) {
      const rows = await db.all<{ id: string }>(sql`
        INSERT INTO suppressions (id, tenant_id, email, reason, source, created_at)
        SELECT ${crypto.randomUUID()}, ${tenantId}, ${email}, 'manual', 'admin', ${Date.now()}
        WHERE NOT EXISTS (
          SELECT 1 FROM suppressions WHERE tenant_id = ${tenantId} AND lower(email) = lower(${email})
        )
        RETURNING id
      `);
      return rows.length > 0;
    },

    async importSuppressions({ tenantId, emails }) {
      const seen = new Set<string>();
      const unique: string[] = [];
      for (const e of emails) {
        const key = e.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(e);
      }
      if (unique.length === 0) return 0;

      const now = Date.now();
      const statements = [];
      for (let i = 0; i < unique.length; i += IMPORT_CHUNK) {
        const values = sql.join(
          unique.slice(i, i + IMPORT_CHUNK).map((e) => sql`(${crypto.randomUUID()}, ${e})`),
          sql`, `,
        );
        statements.push(
          // Builder insert (column order: id, tenant_id, email, reason, source,
          // created_at) so the statements can be batched.
          db.insert(suppressions).select(sql`
            SELECT v.column1, ${tenantId}, v.column2, 'imported', 'csv_import', ${now}
            FROM (VALUES ${values}) AS v
            WHERE NOT EXISTS (
              SELECT 1 FROM suppressions s
              WHERE s.tenant_id = ${tenantId} AND lower(s.email) = lower(v.column2)
            )
          `).returning({ id: suppressions.id }),
        );
      }
      const results = await db.batch(statements as [typeof statements[number], ...typeof statements]);
      return results.reduce((n, rows) => n + rows.length, 0);
    },

    async addSuppressions({ tenantId, emails, reason, source, now }) {
      const seen = new Set<string>();
      const unique: string[] = [];
      for (const e of emails) {
        const key = e.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(e);
      }
      if (unique.length === 0) return [];
      // Which addresses are new is decided by the guarded inserts; the
      // outbox rows are written per inserted address, so each insert is
      // followed by its own guarded outbox insert (same batch, atomic).
      const endpoints = await d1OutboxEndpoints(db, tenantId, [{ event: "contact.suppressed", payload: {} }]);
      const statements: unknown[] = [];
      const order: number[] = [];
      unique.forEach((email, i) => {
        statements.push(
          db.insert(suppressions).select(sql`
            SELECT ${crypto.randomUUID()}, ${tenantId}, ${email}, ${reason}, ${source}, ${now.getTime()}
            WHERE NOT EXISTS (
              SELECT 1 FROM suppressions s WHERE s.tenant_id = ${tenantId} AND lower(s.email) = lower(${email})
            )
          `).returning({ email: suppressions.email }),
        );
        order.push(i);
        for (const st of d1OutboxInserts(db, tenantId, endpoints, [{ event: "contact.suppressed", payload: { email, reason, source } }], now, { afterChange: true })) {
          statements.push(st);
          order.push(-1);
        }
      });
      const results = (await db.batch(statements as never)) as unknown[];
      const inserted: string[] = [];
      results.forEach((r, i) => {
        if (order[i]! >= 0 && Array.isArray(r) && r.length > 0) inserted.push(unique[order[i]!]!);
      });
      return inserted;
    },

    async removeSuppression({ tenantId, email, force, protectedReasons, now }) {
      const [row] = await db
        .select({ id: suppressions.id, reason: suppressions.reason })
        .from(suppressions)
        .where(and(eq(suppressions.tenantId, tenantId), sql`lower(${suppressions.email}) = lower(${email})`))
        .limit(1);
      if (!row) return { result: "not_found" as const, reason: null };
      if (!force && protectedReasons.includes(row.reason)) {
        return { result: "protected" as const, reason: row.reason };
      }
      const entries = [{ event: "contact.resubscribed", payload: { email: email.toLowerCase(), previous_reason: row.reason } }];
      const endpoints = await d1OutboxEndpoints(db, tenantId, entries);
      // The delete is guarded by the reason read above, so a suppression
      // replaced in between (another reason) is not deleted by a stale decision.
      const del = db
        .delete(suppressions)
        .where(and(eq(suppressions.id, row.id), eq(suppressions.reason, row.reason)))
        .returning({ id: suppressions.id });
      const [deleted] = (await db.batch([del, ...d1OutboxInserts(db, tenantId, endpoints, entries, now, { afterChange: true })] as never)) as unknown[][];
      if (!deleted || deleted.length === 0) return { result: "not_found" as const, reason: null };
      return { result: "deleted" as const, reason: row.reason };
    },

    async listSuppressions({ tenantId, after, limit, since }) {
      const where = and(
        eq(suppressions.tenantId, tenantId),
        after
          ? sql`(${suppressions.createdAt}, ${suppressions.id}) > (${new Date(after.createdAt).getTime()}, ${after.id})`
          : undefined,
        since ? sql`${suppressions.createdAt} >= ${since.getTime()}` : undefined,
      );
      return db
        .select()
        .from(suppressions)
        .where(where)
        // Postgres sorts NULL created_at last in ASC order; SQLite sorts it first.
        .orderBy(sql`${suppressions.createdAt} IS NULL`, suppressions.createdAt, suppressions.id)
        .limit(limit);
    },
  };
}
