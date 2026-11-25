/**
 * POST /v1/import/messages (G21): bring a product's sent-message history
 * into Claros so throttle, re-entry, "already sent" and history conditions,
 * and kb_select exclude_used treat it like mail Claros sent.
 *
 * Auth: an owner session or an admin key with the `messages` scope.
 * Body: a JSON array of items, {"messages": [...]}, or JSONL (text/plain,
 * application/x-ndjson, application/jsonl or application/x-jsonlines):
 *   {id?, external_id? | email?, flow_slug, step_order?, action_type, subject?, sent_at, kb_external_key?}
 * Contacts resolve by external_id, else by email; flows by slug. Items are
 * idempotent by `id` when given, else by (contact, flow, step, action,
 * sent_at). ?dry_run=1 validates and resolves without writing.
 * Response: {dry_run, imported, duplicates, errors: [{index, error}]}.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { storeFor, type HistoryImportItem } from "@claros/store";
import type { Db } from "../plugins/db.js";
import { RoleRouter, allowAdminKey } from "../http/router.js";
import { JSONL_PARSERS } from "../http/body.js";

const IMPORT_BODY_LIMIT = 4 * 1024 * 1024;
export const HISTORY_IMPORT_MAX_ITEMS = 2000;

const itemSchema = z
  .object({
    id: z.string().min(1).max(200).optional(),
    external_id: z.string().min(1).max(255).optional(),
    email: z.string().email().max(320).optional(),
    flow_slug: z.string().min(1).max(63),
    step_order: z.number().int().min(1).max(1000).optional(),
    action_type: z.string().min(1).max(120),
    subject: z.string().max(998).nullable().optional(),
    sent_at: z.string().datetime({ offset: true }),
    kb_external_key: z.string().min(1).max(200).nullable().optional(),
  })
  .strict()
  .refine((i) => i.external_id !== undefined || i.email !== undefined, { message: "external_id or email is required" });

function items(body: unknown): { items: unknown[] } | { error: string } {
  if (Array.isArray(body)) return { items: body };
  if (body && typeof body === "object" && Array.isArray((body as { messages?: unknown }).messages)) return { items: (body as { messages: unknown[] }).messages };
  if (typeof body === "string") {
    const out: unknown[] = [];
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        return { error: `line ${i + 1}: not valid JSON` };
      }
    }
    return { items: out };
  }
  return { error: 'Send a JSON array, {"messages": [...]}, or JSONL (text/plain or application/x-ndjson).' };
}

export default function importRoutes() {
  const r = new RoleRouter({ limit: IMPORT_BODY_LIMIT, parsers: JSONL_PARSERS });

  r.post("/messages", "owner", allowAdminKey("messages"), async (c) => {
    const parsed = items(c.var.body);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    if (parsed.items.length > HISTORY_IMPORT_MAX_ITEMS) {
      return c.json({ error: `At most ${HISTORY_IMPORT_MAX_ITEMS} messages per request; split the file.` }, 400);
    }
    const dryRun = ["1", "true"].includes(c.req.query("dry_run") ?? "");
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const errors: Array<{ index: number; error: string }> = [];
    const valid: HistoryImportItem[] = [];
    parsed.items.forEach((raw, index) => {
      const v = itemSchema.safeParse(raw);
      if (!v.success) {
        errors.push({ index, error: v.error.issues.map((i) => `${i.path.join(".") || "item"}: ${i.message}`).join("; ") });
        return;
      }
      const i = v.data;
      const sentAt = new Date(i.sent_at);
      const stepOrder = i.step_order ?? 1;
      const who = i.external_id ? `ext:${i.external_id}` : `email:${i.email!.toLowerCase()}`;
      const importKey = i.id
        ? `id:${i.id}`
        : `h:${createHash("sha256").update(JSON.stringify([who, i.flow_slug, stepOrder, i.action_type, sentAt.toISOString()])).digest("hex").slice(0, 40)}`;
      valid.push({
        index,
        externalId: i.external_id ?? null,
        email: i.email ?? null,
        flowSlug: i.flow_slug,
        stepOrder,
        actionType: i.action_type,
        subject: i.subject ?? null,
        sentAt,
        kbExternalKey: i.kb_external_key ?? null,
        importKey,
      });
    });
    const result = await storeFor(db).apiImport.importMessages({ tenantId, items: valid, dryRun, now: new Date() });
    return c.json({
      dry_run: dryRun,
      imported: result.imported,
      duplicates: result.duplicates,
      errors: [...errors, ...result.errors].sort((a, b) => a.index - b.index),
    });
  });

  return r.app;
}
