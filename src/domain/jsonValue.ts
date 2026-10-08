import { z } from "zod";

/**
 * A JSON-safe value shared by domain, application, and adapter boundaries.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Check JSON structure. A rebuilding parser such as z.json() assigns member
 * names through the object setter surface, which turns an own `__proto__`
 * property into the copy's prototype and silently loses the member.
 */
const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      return isJsonContainer(value);
    default:
      return false;
  }
};

const isJsonContainer = (value: object): boolean => {
  if (Array.isArray(value)) return value.every(isJsonValue);
  const prototype: unknown = Reflect.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return false;
  return Object.values(value).every(isJsonValue);
};

/**
 * Snapshot a validated JSON value the way the replaced z.json() copy did,
 * keeping caller mutations out of parsed results. `Object.fromEntries`
 * assigns members without reaching the setter surface, so an own `__proto__`
 * stays an ordinary own property and a null prototype stays null.
 */
const cloneJson = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value === null || typeof value !== "object") return value;
  const clone = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneJson(item)]),
  );
  if (Reflect.getPrototypeOf(value) === null)
    Object.setPrototypeOf(clone, null);
  return clone;
};

/**
 * Attach the non-recursive JSON Schema projection to every stage of a
 * check+clone pipeline. `.refine()` and friends dissolve the pipe into their
 * own, so overriding only the exported schema leaves the inner custom and
 * transform stages unrepresentable.
 */
const projectJsonValue = <S extends z.ZodType>(
  schema: S,
  projection: unknown,
): S => {
  schema._zod.toJSONSchema = () => projection;
  return schema;
};

const jsonValueCheck = projectJsonValue(
  z.custom<JsonValue>(isJsonValue, "expected a JSON value"),
  {},
);

const jsonValuePipe = jsonValueCheck.transform(cloneJson);
/** JSON-safe value schema that preserves own `__proto__` members. */
export const jsonValueSchema: z.ZodType<JsonValue> = jsonValuePipe;
// Every JSON value satisfies `{}`. Advertise that instead of Zod's
// self-referential `$defs` projection, which MCP clients and model APIs that
// reject recursive JSON Schemas refuse. Runtime parsing still admits only JSON.
projectJsonValue(jsonValuePipe, {});
projectJsonValue(jsonValuePipe._zod.def.out, {});

/** JSON object boundary for caller-visible parameter maps. */
const jsonObjectCheck = projectJsonValue(
  z.custom<{ [key: string]: JsonValue }>(
    (value): value is { [key: string]: JsonValue } =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      isJsonContainer(value),
    "expected a JSON object",
  ),
  { type: "object" },
);
const jsonObjectPipe = jsonObjectCheck.transform(
  (value) => cloneJson(value) as { [key: string]: JsonValue },
);
export const jsonObjectSchema: z.ZodType<{ [key: string]: JsonValue }> =
  jsonObjectPipe;
projectJsonValue(jsonObjectPipe, { type: "object" });
projectJsonValue(jsonObjectPipe._zod.def.out, { type: "object" });
