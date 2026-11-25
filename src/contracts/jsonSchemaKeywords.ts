import { isRecord } from "../kernel/isRecord.js";
export const schemaMaps = new Set([
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
]);
export const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
export const schemaChildren = new Set([
  "items",
  "additionalItems",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "contentSchema",
  "not",
  "if",
  "then",
  "else",
]);

/** Visit schema-valued positions without interpreting instance-valued keywords. */
export const schemaSubschemas = (
  schema: Readonly<Record<string, unknown>>,
  options: { readonly includeDefinitions: boolean },
): unknown[] =>
  Object.entries(schema).flatMap(([key, value]) => {
    if (schemaMaps.has(key) && isRecord(value))
      return !options.includeDefinitions &&
        (key === "$defs" || key === "definitions")
        ? []
        : Object.values(value);
    if (schemaArrays.has(key) && Array.isArray(value)) return value;
    if (schemaChildren.has(key)) return Array.isArray(value) ? value : [value];
    return [];
  });

/** Assign an own data property without triggering `__proto__` prototype mutation. */
export const setOwnSchemaProperty = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void => {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  } else {
    target[key] = value;
  }
};

const mapSchemaMap = (
  mapValue: Record<string, unknown>,
  keyword: string,
  map: (child: unknown, keyword: string) => unknown,
): Record<string, unknown> => {
  let out: Record<string, unknown> | undefined;
  for (const name in mapValue) {
    if (!Object.hasOwn(mapValue, name)) continue;
    const child = mapValue[name];
    const mapped = map(child, keyword);
    if (mapped !== child) {
      if (out === undefined) out = { ...mapValue };
      setOwnSchemaProperty(out, name, mapped);
    }
  }
  return out ?? mapValue;
};

const mapSchemaArray = (
  items: readonly unknown[],
  keyword: string,
  map: (child: unknown, keyword: string) => unknown,
): readonly unknown[] => {
  let out: unknown[] | undefined;
  for (let i = 0; i < items.length; i++) {
    const child = items[i];
    const mapped = map(child, keyword);
    if (mapped !== child) {
      if (out === undefined) out = items.slice();
      out[i] = mapped;
    }
  }
  return out ?? items;
};

/**
 * Copy-on-write map over every direct subschema position of `schema`.
 * Returns `schema` itself when no child changes; skips `skipKeyword` when given.
 */
export const mapSchemaChildren = (
  schema: Record<string, unknown>,
  map: (child: unknown, keyword: string) => unknown,
  skipKeyword?: string,
): Record<string, unknown> => {
  let out: Record<string, unknown> | undefined;
  for (const keyword in schema) {
    if (!Object.hasOwn(schema, keyword) || keyword === skipKeyword) continue;
    const value = schema[keyword];
    let nextValue = value;
    if (schemaMaps.has(keyword)) {
      if (isRecord(value)) nextValue = mapSchemaMap(value, keyword, map);
    } else if (schemaArrays.has(keyword)) {
      if (Array.isArray(value)) nextValue = mapSchemaArray(value, keyword, map);
    } else if (schemaChildren.has(keyword)) {
      nextValue = Array.isArray(value)
        ? mapSchemaArray(value, keyword, map)
        : map(value, keyword);
    }
    if (nextValue !== value) {
      if (out === undefined) out = { ...schema };
      setOwnSchemaProperty(out, keyword, nextValue);
    }
  }
  return out ?? schema;
};

/** Instance values, unless explicitly reached by a schema reference. */
export const schemaLiteralValues = new Set([
  "const",
  "enum",
  "default",
  "examples",
]);

/** One segment of a JSON Pointer into a schema, classified by position. */
export type SchemaPointerStep =
  | { readonly kind: "keyword"; readonly keyword: string }
  | { readonly kind: "entry" }
  | { readonly kind: "value"; readonly keyword: string };

/**
 * Classify each segment of a JSON Pointer into a schema by its position, so a
 * map entry or property named like a keyword is never read as that keyword.
 * The walk ends at the first keyword that is not a subschema keyword (such as
 * `default`); the segments after it address instance data and are omitted.
 */
export const schemaPointerSteps = (
  path: readonly string[],
): SchemaPointerStep[] => {
  const steps: SchemaPointerStep[] = [];
  let position: "schema" | "entry" | "schemaOrIndex" = "schema";
  for (const segment of path) {
    if (
      position === "entry" ||
      (position === "schemaOrIndex" && /^(?:0|[1-9]\d*)$/u.test(segment))
    ) {
      steps.push({ kind: "entry" });
      position = "schema";
      continue;
    }
    if (schemaMaps.has(segment) || schemaArrays.has(segment)) {
      steps.push({ kind: "keyword", keyword: segment });
      position = "entry";
      continue;
    }
    if (schemaChildren.has(segment)) {
      steps.push({ kind: "keyword", keyword: segment });
      // `items` and its siblings may hold a draft-07 tuple array.
      position = "schemaOrIndex";
      continue;
    }
    steps.push({ kind: "value", keyword: segment });
    break;
  }
  return steps;
};
