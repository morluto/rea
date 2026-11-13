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
