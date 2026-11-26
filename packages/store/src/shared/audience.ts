/**
 * The paid / free audience split as SQL conditions, shared by the Postgres
 * and D1 adapters (the SQL is the same in both dialects).
 *
 * The split is on the contact's CURRENT payment_status. Paying means
 * PAYING_PAYMENT_STATUSES (the same set as the retention grid's `paying`
 * column); free is every other value, including NULL, so paid + free = all.
 */
import { sql, type SQL } from "drizzle-orm";
import { PAYING_PAYMENT_STATUSES, type ContactAudience } from "@claros/core";

// Constant, code-defined values: safe to inline.
const PAYING_LIST = sql.raw(PAYING_PAYMENT_STATUSES.map((s) => `'${s}'`).join(", "));

/**
 * The audience as a condition on a contacts row, or null for "all" (no
 * condition). `column` is the payment_status column reference.
 */
export function audienceCondition(
  audience: ContactAudience | undefined,
  column: SQL = sql.raw("payment_status"),
): SQL | null {
  switch (audience ?? "all") {
    case "paid":
      return sql`${column} IN (${PAYING_LIST})`;
    case "free":
      return sql`(${column} IS NULL OR ${column} NOT IN (${PAYING_LIST}))`;
    default:
      return null;
  }
}

/** `AND <condition>` for the audience on a contacts query, or empty for "all". */
export function andAudience(audience: ContactAudience | undefined): SQL {
  const cond = audienceCondition(audience);
  return cond === null ? sql`` : sql`AND ${cond}`;
}

/**
 * `AND contact_id IN (...)` restricting rows of a contact-keyed table (here
 * lifecycle_transitions) to the tenant's contacts in the audience, or empty
 * for "all". The audience is read from the contact's current payment_status.
 */
export function andContactInAudience(
  tenantId: string,
  audience: ContactAudience | undefined,
): SQL {
  const cond = audienceCondition(audience);
  if (cond === null) return sql``;
  return sql`AND contact_id IN (
    SELECT id FROM contacts WHERE tenant_id = ${tenantId} AND ${cond}
  )`;
}
