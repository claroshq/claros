/**
 * JSON Schema (draft 2020-12) from the Zod schemas this repo uses, for the
 * generated docs/reference/claros.config.schema.json. Covers the Zod types
 * the config schema is built from; refinements (superRefine) are checked by
 * the API only and are not expressed here.
 */
import type { ZodTypeAny } from "zod";

type Json = Record<string, unknown>;

interface Def {
  typeName: string;
  [k: string]: unknown;
}

function def(s: ZodTypeAny): Def {
  return (s as unknown as { _def: Def })._def;
}

/** True when the schema accepts undefined (optional or with a default). */
function isOptional(s: ZodTypeAny): boolean {
  const d = def(s);
  if (d.typeName === "ZodOptional" || d.typeName === "ZodDefault") return true;
  if (d.typeName === "ZodEffects") return isOptional(d.schema as ZodTypeAny);
  return false;
}

/** Named recursive schemas (z.lazy with a jsonSchemaName) collected as $defs. */
let defs: Record<string, Json> | null = null;

export function zodToJsonSchema(s: ZodTypeAny): Json {
  const d = def(s);
  if (d.typeName === "ZodLazy") {
    const name = (s as unknown as { jsonSchemaName?: string }).jsonSchemaName;
    if (!name) throw new Error("zodToJsonSchema: z.lazy needs a jsonSchemaName");
    if (!defs) throw new Error("zodToJsonSchema: recursive schemas need configJsonSchema()");
    if (!defs[name]) {
      defs[name] = {};
      defs[name] = zodToJsonSchema((d.getter as () => ZodTypeAny)());
    }
    return { $ref: `#/$defs/${name}` };
  }
  const out: Json = {};
  if (typeof (s as { description?: string }).description === "string") out.description = (s as { description: string }).description;
  switch (d.typeName) {
    case "ZodString": {
      out.type = "string";
      for (const c of (d.checks as Array<{ kind: string; value?: number; regex?: RegExp }>) ?? []) {
        if (c.kind === "min") out.minLength = c.value;
        else if (c.kind === "max") out.maxLength = c.value;
        else if (c.kind === "regex" && c.regex) out.pattern = c.regex.source;
        else if (c.kind === "url") out.format = "uri";
      }
      return out;
    }
    case "ZodNumber": {
      out.type = "number";
      for (const c of (d.checks as Array<{ kind: string; value?: number; inclusive?: boolean }>) ?? []) {
        if (c.kind === "int") out.type = "integer";
        else if (c.kind === "min") out[c.inclusive === false ? "exclusiveMinimum" : "minimum"] = c.value;
        else if (c.kind === "max") out[c.inclusive === false ? "exclusiveMaximum" : "maximum"] = c.value;
      }
      return out;
    }
    case "ZodBoolean":
      return { ...out, type: "boolean" };
    case "ZodLiteral":
      return { ...out, const: d.value };
    case "ZodEnum":
      return { ...out, type: "string", enum: d.values as string[] };
    case "ZodUnknown":
    case "ZodAny":
      return out;
    case "ZodArray": {
      out.type = "array";
      out.items = zodToJsonSchema(d.type as ZodTypeAny);
      const min = d.minLength as { value: number } | null;
      const max = d.maxLength as { value: number } | null;
      if (min) out.minItems = min.value;
      if (max) out.maxItems = max.value;
      return out;
    }
    case "ZodRecord": {
      out.type = "object";
      out.additionalProperties = zodToJsonSchema(d.valueType as ZodTypeAny);
      const key = zodToJsonSchema(d.keyType as ZodTypeAny);
      if (typeof key.pattern === "string") out.propertyNames = { pattern: key.pattern };
      return out;
    }
    case "ZodObject": {
      const shape = (d.shape as () => Record<string, ZodTypeAny>)();
      const properties: Json = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = zodToJsonSchema(v);
        if (!isOptional(v)) required.push(k);
      }
      out.type = "object";
      out.properties = properties;
      if (required.length > 0) out.required = required;
      if (d.unknownKeys === "strict") out.additionalProperties = false;
      return out;
    }
    case "ZodUnion":
      return { ...out, anyOf: (d.options as ZodTypeAny[]).map(zodToJsonSchema) };
    case "ZodOptional":
      return { ...zodToJsonSchema(d.innerType as ZodTypeAny), ...out };
    case "ZodNullable": {
      const inner = zodToJsonSchema(d.innerType as ZodTypeAny);
      return { ...out, anyOf: [inner, { type: "null" }] };
    }
    case "ZodDefault":
      return { ...zodToJsonSchema(d.innerType as ZodTypeAny), ...out, default: (d.defaultValue as () => unknown)() };
    case "ZodEffects":
      return { ...zodToJsonSchema(d.schema as ZodTypeAny), ...out };
    default:
      throw new Error(`zodToJsonSchema: unsupported Zod type ${d.typeName}`);
  }
}

/** The JSON Schema document of the config file. */
export function configJsonSchema(schema: ZodTypeAny): Json {
  defs = {};
  try {
    const body = zodToJsonSchema(schema);
    const collected = defs;
    return {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://github.com/claroshq/claros/blob/main/docs/reference/claros.config.schema.json",
      title: "Claros product configuration (claros apply, PUT /v1/config)",
      ...body,
      ...(Object.keys(collected).length > 0
        ? { $defs: Object.fromEntries(Object.keys(collected).sort().map((k) => [k, collected[k]])) }
        : {}),
    };
  } finally {
    defs = null;
  }
}
