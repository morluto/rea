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
    if (
      schemaMaps.has(key) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    )
      return !options.includeDefinitions &&
        (key === "$defs" || key === "definitions")
        ? []
        : Object.values(value);
    if (schemaArrays.has(key) && Array.isArray(value)) return value;
    if (schemaChildren.has(key)) return Array.isArray(value) ? value : [value];
    return [];
  });

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
