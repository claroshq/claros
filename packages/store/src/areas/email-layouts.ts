/**
 * Queries for custom email templates (table email_layouts): used by
 * packages/api/src/routes/layouts.ts (the Templates page and API), by the
 * drain (packages/worker/src/drain.ts) and by test sends, which render a
 * product's stored template. Implementations: ../pg/email-layouts.ts and
 * ../d1/email-layouts.ts.
 */

export interface EmailLayoutRow {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  /** narrow | wide */
  width: string;
  source: string;
  basedOn: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EmailLayoutsQueries {
  /** The product's templates, most recently changed first. */
  listLayouts(tenantId: string): Promise<EmailLayoutRow[]>;
  /** One template of the product, or null. */
  getLayout(input: { tenantId: string; id: string }): Promise<EmailLayoutRow | null>;
  createLayout(input: {
    tenantId: string;
    name: string;
    description: string | null;
    width: string;
    source: string;
    basedOn: string | null;
    now: Date;
  }): Promise<EmailLayoutRow>;
  /** Change the given fields; null when the template does not exist. */
  updateLayout(input: {
    tenantId: string;
    id: string;
    patch: { name?: string; description?: string | null; width?: string; source?: string };
    now: Date;
  }): Promise<EmailLayoutRow | null>;
  /** True when a template was deleted. */
  deleteLayout(input: { tenantId: string; id: string }): Promise<boolean>;
}
