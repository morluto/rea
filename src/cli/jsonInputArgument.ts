import { z } from "incur";

const JSON_SCHEMA_DIALECT = "$schema";
const wrapperTypes = new Set([
  "optional",
  "nonoptional",
  "nullable",
  "default",
  "prefault",
  "readonly",
  "catch",
]);

const innerSchema = (schema: z.ZodType): z.ZodType | undefined => {
  if (!("unwrap" in schema) || typeof schema.unwrap !== "function")
    return undefined;
  const inner: unknown = schema.unwrap();
  return inner instanceof z.ZodType ? inner : undefined;
};

/** Skip wrappers so `unknown` and `any` are recognized as the whole document. */
const documentType = (schema: z.ZodType): string => {
  let current = schema;
  for (;;) {
    const type = current._zod.def.type;
    if (!wrapperTypes.has(type)) return type;
    const inner = innerSchema(current);
    if (inner === undefined) return type;
    current = inner;
  }
};

/**
 * JSON Schema for one positional JSON document.
 *
 * `{}` is only returned for a document the handler parses as `unknown` or
 * `any`. Any other empty conversion is omitted: a custom or unrepresentable
 * document must not be advertised as accepting every value. Input mode keeps
 * the type a transform accepts, so a string transform stays a string.
 */
export const jsonInputContentSchema = (
  schema: z.ZodType,
): Record<string, unknown> | undefined => {
  let converted: Record<string, unknown>;
  try {
    converted = z.toJSONSchema(schema, {
      io: "input",
      unrepresentable: "any",
    }) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const content = { ...converted };
  delete content[JSON_SCHEMA_DIALECT];
  if (Object.keys(content).length > 0) return content;
  const type = documentType(schema);
  return type === "unknown" || type === "any" ? {} : undefined;
};

/** Keep the positional string and attach the document contract Incur can see. */
export const jsonInputArgument = (
  description: string,
  schema: z.ZodType,
): z.ZodString => {
  const argument = z.string().describe(description);
  const contentSchema = jsonInputContentSchema(schema);
  return contentSchema === undefined
    ? argument.meta({ contentMediaType: "application/json" })
    : argument.meta({
        contentMediaType: "application/json",
        contentSchema,
      });
};
