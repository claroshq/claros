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

    async listSuppressions({ tenantId, after, limit }) {
      const where = after
        ? and(
            eq(suppressions.tenantId, tenantId),
            sql`(${suppressions.createdAt}, ${suppressions.id}) > (${new Date(after.createdAt).getTime()}, ${after.id})`,
          )
        : eq(suppressions.tenantId, tenantId);
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
