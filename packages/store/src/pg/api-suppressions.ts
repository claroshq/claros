/**
 * Postgres implementation of the queries used by packages/api/src/routes/suppressions.ts.
 */
import { eq, and, sql } from "drizzle-orm";
import { suppressions } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiSuppressionsQueries } from "../areas/api-suppressions.js";
import { pgWriteOutbox } from "./outbox.js";

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

    async addSuppressions({ tenantId, emails, reason, source, now }) {
      if (emails.length === 0) return [];
      const emailsSql = sql.join(emails.map((e) => sql`${e}`), sql`, `);
      return db.transaction(async (tx) => {
        // WITH ORDINALITY keeps list order, so the first occurrence of a
        // case-insensitive duplicate is the one inserted.
        const result = await tx.execute<{ email: string }>(sql`
          INSERT INTO suppressions (tenant_id, email, reason, source, created_at)
          SELECT ${tenantId}::uuid, e.email, ${reason}, ${source}, ${now}
          FROM unnest(ARRAY[${emailsSql}]::text[]) WITH ORDINALITY AS e(email, n)
          ORDER BY e.n
          ON CONFLICT (tenant_id, lower(email)) DO NOTHING
          RETURNING email
        `);
        const inserted = result.rows.map((r) => r.email);
        await pgWriteOutbox(
          tx as unknown as PgDb,
          tenantId,
          inserted.map((email) => ({ event: "contact.suppressed", payload: { email, reason, source } })),
          now,
        );
        return inserted;
      });
    },

    async removeSuppression({ tenantId, email, force, protectedReasons, now }) {
      return db.transaction(async (tx) => {
        const found = await tx.execute<{ id: string; reason: string }>(sql`
          SELECT id, reason FROM suppressions
          WHERE tenant_id = ${tenantId}::uuid AND lower(email) = lower(${email})
          FOR UPDATE
        `);
        const row = found.rows[0];
        if (!row) return { result: "not_found" as const, reason: null };
        if (!force && protectedReasons.includes(row.reason)) {
          return { result: "protected" as const, reason: row.reason };
        }
        await tx.execute(sql`DELETE FROM suppressions WHERE id = ${row.id}::uuid`);
        await pgWriteOutbox(tx as unknown as PgDb, tenantId, [
          { event: "contact.resubscribed", payload: { email: email.toLowerCase(), previous_reason: row.reason } },
        ], now);
        return { result: "deleted" as const, reason: row.reason };
      });
    },

    async listSuppressions({ tenantId, after, limit, since }) {
      if (since) {
        const rows = await db
          .select()
          .from(suppressions)
          .where(
            and(
              eq(suppressions.tenantId, tenantId),
              sql`${suppressions.createdAt} >= ${since}`,
              after
                ? sql`ROW(date_trunc('milliseconds', ${suppressions.createdAt}), ${suppressions.id}) >
                      ROW(${after.createdAt}::timestamptz, ${after.id}::uuid)`
                : sql`TRUE`,
            ),
          )
          .orderBy(sql`date_trunc('milliseconds', ${suppressions.createdAt}) ASC`, suppressions.id)
          .limit(limit);
        return rows;
      }
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
