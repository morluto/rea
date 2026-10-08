import { z } from "zod";

/**
 * Validate the JSON shape with Zod's JSON schema. The parse output is rebuilt
 * by {@link preserveJsonValue} below, which keeps prototype-named members
 * that Zod's record projection drops as a prototype-pollution guard.
 */
const jsonShapeSchema = z.json();

/**
 * Rebuild a validated JSON value as plain objects and arrays, keeping
 * prototype-named own members (`__proto__`, `constructor`, `prototype`) as
 * ordinary data properties. `__proto__` is defined explicitly instead of
 * assigned so the `Object.prototype` setter never runs and the prototype is
 * never mutated; the other names are safe under plain assignment.
 */
const preserveJsonValue = (value: unknown): JsonValue => {
  if (Array.isArray(value)) return value.map((item) => preserveJsonValue(item));
  if (value !== null && typeof value === "object") {
    const preserved: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
      const member = preserveJsonValue((value as Record<string, unknown>)[key]);
      if (key === "__proto__")
        Object.defineProperty(preserved, key, {
          value: member,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      else preserved[key] = member;
    }
    return preserved;
  }
  return value as JsonValue;
};

/**
 * JSON value with prototype-named members preserved as ordinary own data
 * properties. Structurally identical to Zod's inferred JSON type.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** JSON-safe value shared by domain, application, and adapter boundaries. */
export const jsonValueSchema = z
  .custom<JsonValue>(
    (input) => jsonShapeSchema.safeParse(input).success,
    "Invalid JSON value",
  )
  .transform((input) => preserveJsonValue(input));
// Every JSON value satisfies `{}`. Advertise that instead of Zod's
// self-referential `$defs` projection, which MCP clients and model APIs that
// reject recursive JSON Schemas refuse. Runtime parsing still admits only JSON.
jsonValueSchema._zod.toJSONSchema = () => ({});

/** JSON object boundary for caller-visible parameter maps. */
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
