/**
 * Body validation for routes that v0.6 validated with a JSON schema.
 *
 * Failures answer 400 with the v0.6 framework shape:
 *   { statusCode: 400, code: "FST_ERR_VALIDATION", error: "Bad Request", message }
 * The message names the first failing field the way v0.6 did
 * ("body must have required property 'email'", "body/port must be <= 65535").
 */
import { z } from "zod";
import type { AppContext } from "./env.js";
import { frameworkError } from "./errors.js";

export type Validated<T> = { ok: true; value: T } | { ok: false; response: Response };

function validate<S extends z.ZodTypeAny>(
  c: AppContext,
  schema: S,
  value: unknown,
  where: "body" | "querystring" | "params",
): Validated<z.infer<S>> {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, response: frameworkError(c, 400, "FST_ERR_VALIDATION", `${where} must be object`) };
  }
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };

  const issue = result.error.issues[0]!;
  let message: string;
  if (issue.code === "invalid_type" && issue.received === "undefined") {
    message = `${where} must have required property '${issue.path.join(".")}'`;
  } else if (issue.code === "unrecognized_keys") {
    message = `${where} must NOT have additional properties`;
  } else {
    const at = issue.path.length > 0 ? `${where}/${issue.path.join("/")}` : where;
    message = `${at} ${issue.message}`;
  }
  return { ok: false, response: frameworkError(c, 400, "FST_ERR_VALIDATION", message) };
}

/** Validate c.var.body against a schema v0.6 declared as `schema.body`. */
export function validateBody<S extends z.ZodTypeAny>(c: AppContext, schema: S): Validated<z.infer<S>> {
  return validate(c, schema, c.var.body, "body");
}

/** Validate the query string against a schema v0.6 declared as `schema.querystring`. */
export function validateQuery<S extends z.ZodTypeAny>(c: AppContext, schema: S): Validated<z.infer<S>> {
  return validate(c, schema, c.req.query(), "querystring");
}

/** Validate path params against a schema v0.6 declared as `schema.params`. */
export function validateParams<S extends z.ZodTypeAny>(c: AppContext, schema: S): Validated<z.infer<S>> {
  return validate(c, schema, c.req.param(), "params");
}

/*
 * v0.6 validated with Ajv in Fastify's default mode (coerceTypes: "array",
 * removeAdditional): unknown properties are removed (zod objects strip them
 * by default) and scalars are coerced. The helpers below reproduce Ajv's
 * coercion for non-nullable fields:
 *   - a one-item array is unwrapped to its item;
 *   - string: number/boolean -> String(x), null -> "";
 *   - integer/number: numeric string -> number, boolean -> 0/1, null -> 0;
 *   - boolean: "true"/"false", 1/0 -> boolean, null -> false.
 * For nullable fields wrap the helper with .nullable(): null stays null.
 */
const unwrap = (v: unknown) => (Array.isArray(v) && v.length === 1 ? v[0] : v);

const toNumber = (v: unknown): unknown => {
  const x = unwrap(v);
  if (x === null) return 0;
  if (typeof x === "boolean") return Number(x);
  if (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x))) return Number(x);
  return x;
};

export const coerceInt = () => z.preprocess(toNumber, z.number().int());

export const coerceNumber = () => z.preprocess(toNumber, z.number());

export const coerceBool = () =>
  z.preprocess((v) => {
    const x = unwrap(v);
    if (x === null) return false;
    if (x === "true" || x === 1) return true;
    if (x === "false" || x === 0) return false;
    return x;
  }, z.boolean());

export const coerceString = () =>
  z.preprocess((v) => {
    const x = unwrap(v);
    if (x === null) return "";
    if (typeof x === "number" || typeof x === "boolean") return String(x);
    return x;
  }, z.string());
