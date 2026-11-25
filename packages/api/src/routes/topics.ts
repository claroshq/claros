/**
 * Topics (G8a): the subscription categories of a product.
 *
 *   GET   /v1/topics        list the product's topics (member)
 *   POST  /v1/topics        create a topic (owner)
 *                           { slug, name, kind, description?, default_subscribed? }
 *   PATCH /v1/topics/:id    update name, kind, description, default_subscribed (owner);
 *                           the slug is fixed after creation
 *
 * kind: marketing | lifecycle | transactional. A flow with a topic sends
 * mail of that topic: contacts unsubscribed from it (contact_topics, set by
 * identify `topics` traits or the unsubscribe page) do not receive it, except
 * for transactional topics, which only the suppression list blocks.
 * Transactional-topic mail carries no List-Unsubscribe headers (D18) and is
 * the only mail a `cloudflare` transport may send (D16).
 */
import { z } from "zod";
import { storeFor, type TopicRow } from "@claros/store";
import { TOPIC_KINDS, TOPIC_SLUG_PATTERN } from "@claros/core";
import type { Db } from "../plugins/db.js";
import { RoleRouter } from "../http/router.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const kindSchema = z.enum(TOPIC_KINDS as unknown as [string, ...string[]], {
  errorMap: () => ({ message: `kind must be one of: ${TOPIC_KINDS.join(", ")}` }),
});

const createTopicSchema = z.object({
  slug: z
    .string()
    .regex(TOPIC_SLUG_PATTERN, "slug must be 1 to 63 characters of a-z, 0-9, _ and -, starting with a letter or digit"),
  name: z.string().trim().min(1, "name is required").max(200),
  kind: kindSchema,
  description: z.string().max(2000).nullable().optional(),
  default_subscribed: z.boolean().optional(),
});

const updateTopicSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(200).optional(),
    kind: kindSchema.optional(),
    description: z.string().max(2000).nullable().optional(),
    default_subscribed: z.boolean().optional(),
  })
  .strict();

export function serializeTopic(row: TopicRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    description: row.description,
    default_subscribed: row.defaultSubscribed,
    created_at: row.createdAt,
  };
}

function validationError(c: { json: (b: unknown, s: 400) => Response }, issues: z.ZodIssue[]): Response {
  return c.json(
    {
      error: "Validation failed",
      issues: issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    },
    400,
  );
}

export default function topicsRoutes() {
  const r = new RoleRouter();

  r.get("/", "member", async (c) => {
    const db: Db = c.var.db;
    const rows = await storeFor(db).apiTopics.listTopics(c.var.tenant!.id);
    return c.json({ topics: rows.map(serializeTopic) });
  });

  r.post("/", "owner", async (c) => {
    const parsed = createTopicSchema.safeParse(c.var.body);
    if (!parsed.success) return validationError(c, parsed.error.issues);
    const db: Db = c.var.db;
    const body = parsed.data;
    const row = await storeFor(db).apiTopics.createTopic({
      tenantId: c.var.tenant!.id,
      slug: body.slug,
      name: body.name,
      kind: body.kind,
      description: body.description ?? null,
      defaultSubscribed: body.default_subscribed ?? true,
    });
    if (!row) return c.json({ error: `A topic with slug "${body.slug}" already exists.` }, 409);
    return c.json({ topic: serializeTopic(row) }, 201);
  });

  r.patch("/:id", "owner", async (c) => {
    const id = c.req.param("id") ?? "";
    if (!UUID_RE.test(id)) return c.json({ error: "Topic not found." }, 404);
    const parsed = updateTopicSchema.safeParse(c.var.body ?? {});
    if (!parsed.success) return validationError(c, parsed.error.issues);
    const db: Db = c.var.db;
    const body = parsed.data;
    const row = await storeFor(db).apiTopics.updateTopic({
      tenantId: c.var.tenant!.id,
      id: id.toLowerCase(),
      patch: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.default_subscribed !== undefined ? { defaultSubscribed: body.default_subscribed } : {}),
      },
    });
    if (!row) return c.json({ error: "Topic not found." }, 404);
    return c.json({ topic: serializeTopic(row) });
  });

  return r.app;
}
