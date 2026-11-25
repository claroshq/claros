/**
 * Postgres implementation of the queries used by packages/api/src/routes/suppressions.ts.
 */
import { eq, and, sql } from "drizzle-orm";
import { suppressions } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiSuppressionsQueries } from "../areas/api-suppressions.js";

export function pgApiSuppressions(db: PgDb): ApiSuppressionsQueries {
  return {
    async addManualSuppression({ tenantId, email }) {
      const result = await db.execute<{ id: string }>(sql`
        INSERT INTO suppressions (tenant_id, email, reason, source)
        VALUES (${tenantId}::uuid, ${email}, 'manual', 'admin')
        ON CONFLICT (tenant_id, lower(email)) DO NOTHING
        RETURNING id
      `);
      return result.rows.length > 0;
    },

    async importSuppressions({ tenantId, emails }) {
      // The ON CONFLICT clause must reference the functional index expression
      // (tenant_id, lower(email)) so Postgres uses the
      // uq_suppressions_tenant_email_lower index to detect conflicts. Both
      // within-batch duplicates and existing rows are caught.
      const emailsSql = sql.join(
        emails.map((e) => sql`${e}`),
        sql`, `,
      );

      const result = await db.execute<{ id: string }>(sql`
        INSERT INTO suppressions (tenant_id, email, reason, source)
        SELECT ${tenantId}::uuid, e.email, 'imported', 'csv_import'
        FROM unnest(ARRAY[${emailsSql}]::text[]) AS e(email)
        ON CONFLICT (tenant_id, lower(email)) DO NOTHING
        RETURNING id
      `);
      return result.rows.length;
    },

    async listSuppressions({ tenantId, after, limit }) {
      if (after) {
        const cursorCreatedAt = after.createdAt;
        const cursorId = after.id;

        return db
          .select()
          .from(suppressions)
          .where(
            and(
              eq(suppressions.tenantId, tenantId),
              sql`
                ROW(date_trunc('milliseconds', ${suppressions.createdAt}), ${suppressions.id}) >
                ROW(${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
              `,
            ),
          )
          .orderBy(sql`date_trunc('milliseconds', ${suppressions.createdAt}) ASC`, suppressions.id)
          .limit(limit);
      }
      return db
        .select()
        .from(suppressions)
        .where(eq(suppressions.tenantId, tenantId))
        .orderBy(sql`date_trunc('milliseconds', ${suppressions.createdAt}) ASC`, suppressions.id)
        .limit(limit);
    },
  };
}
