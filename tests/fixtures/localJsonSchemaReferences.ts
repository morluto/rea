const schemaMaps = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
]);
const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaChildren = new Set([
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
const lowerBounds = new Set(["minimum", "exclusiveMinimum"]);
const upperBounds = new Set(["maximum", "exclusiveMaximum"]);
const annotations = new Set([
  "title",
  "description",
  "$comment",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);
const scopedKeywords = new Set([
  "properties",
  "patternProperties",
  "additionalProperties",
  "items",
  "additionalItems",
  "prefixItems",
  "contains",
  "unevaluatedProperties",
  "unevaluatedItems",
]);

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const compatibleSibling = (
  key: string,
  previous: unknown,
  value: unknown,
): boolean =>
  previous === undefined ||
  JSON.stringify(previous) === JSON.stringify(value) ||
  annotations.has(key) ||
  (typeof previous === "number" &&
    typeof value === "number" &&
    (lowerBounds.has(key) || upperBounds.has(key)));

const mergeSiblings = (
  schema: Record<string, unknown>,
  siblings: Record<string, unknown>,
): Record<string, unknown> => {
  const merged = { ...schema, ...siblings };
  for (const [key, value] of Object.entries(siblings)) {
    const previous = schema[key];
    if (!compatibleSibling(key, previous, value))
      throw new Error(`Conflicting schema reference sibling: ${key}`);
    if (typeof previous !== "number" || typeof value !== "number") continue;
    if (lowerBounds.has(key)) merged[key] = Math.max(previous, value);
    else if (upperBounds.has(key)) merged[key] = Math.min(previous, value);
  }
  return merged;
};

const normalizeStringIntersection = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  if (
    (schema.type !== undefined && schema.type !== "string") ||
    !Array.isArray(schema.allOf)
  )
    return schema;
  let requiresString = schema.type === "string";
  const validBounds = (value: Record<string, unknown>): boolean =>
    ["minLength", "maxLength"].every(
      (key) =>
        !Object.hasOwn(value, key) ||
        (typeof value[key] === "number" &&
          Number.isInteger(value[key]) &&
          value[key] >= 0),
    ) &&
    (!Object.hasOwn(value, "pattern") || typeof value.pattern === "string");
  if (!validBounds(schema)) return schema;
  const patterns = new Set<string>();
  let minimum = typeof schema.minLength === "number" ? schema.minLength : 0;
  let maximum =
    typeof schema.maxLength === "number" ? schema.maxLength : Infinity;
  if (typeof schema.pattern === "string") patterns.add(schema.pattern);
  const collect = (child: unknown): boolean => {
    if (!record(child) || (child.type !== undefined && child.type !== "string"))
      return false;
    if (
      !validBounds(child) ||
      (Object.hasOwn(child, "allOf") && !Array.isArray(child.allOf))
    )
      return false;
    if (child.type === "string") requiresString = true;
    if (
      Object.keys(child).some(
        (key) =>
          !["type", "pattern", "minLength", "maxLength", "allOf"].includes(key),
      )
    )
      return false;
    if (typeof child.pattern === "string") patterns.add(child.pattern);
    if (typeof child.minLength === "number")
      minimum = Math.max(minimum, child.minLength);
    if (typeof child.maxLength === "number")
      maximum = Math.min(maximum, child.maxLength);
    return !Array.isArray(child.allOf) || child.allOf.every(collect);
  };
  if (!schema.allOf.every(collect) || !requiresString) return schema;
  const {
    allOf: _allOf,
    pattern: _pattern,
    minLength: _min,
    maxLength: _max,
    ...root
  } = schema;
  const unique = [...patterns];
  return {
    ...root,
    type: "string",
    ...(minimum > 0 ? { minLength: minimum } : {}),
    ...(maximum < Infinity ? { maxLength: maximum } : {}),
    ...(unique.length === 1 ? { pattern: unique[0] } : {}),
    ...(unique.length > 1
      ? { allOf: unique.map((pattern) => ({ type: "string", pattern })) }
      : {}),
  };
};

/** Inline finite local references for representation-independent schema assertions. */
export const inlineLocalJsonSchemaReferences = (
  root: Readonly<Record<string, unknown>>,
): unknown => {
  const resolve = (reference: string): Record<string, unknown> => {
    if (!reference.startsWith("#/"))
      throw new Error(`Expected a local schema reference: ${reference}`);
    let current: unknown = root;
    for (const encoded of reference.slice(2).split("/")) {
      const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
      if (!record(current) || !Object.hasOwn(current, key))
        throw new Error(`Missing schema reference: ${reference}`);
      current = current[key];
    }
    if (!record(current))
      throw new Error(`Expected a referenced schema object: ${reference}`);
    return current;
  };

  const visit = (value: unknown, active: ReadonlySet<string>): unknown => {
    if (!record(value)) return value;
    if (typeof value.$ref === "string") {
      const { $ref: reference, ...siblings } = value;
      if (active.has(reference))
        throw new Error(`Recursive schema reference: ${reference}`);
      const referenced = resolve(reference);
      // Keep declarations in their original evaluation scope.
      if (Object.keys(siblings).some((key) => scopedKeywords.has(key)))
        return {
          allOf: [
            visit(referenced, new Set([...active, reference])),
            visit(siblings, active),
          ],
        };
      return visit(
        mergeSiblings(referenced, siblings),
        new Set([...active, reference]),
      );
    }
    if (Array.isArray(value.allOf) && value.allOf.length === 1) {
      const child = visit(value.allOf[0], active);
      const { allOf: _allOf, ...siblings } = value;
      if (
        record(child) &&
        !Object.keys(siblings).some((key) => scopedKeywords.has(key)) &&
        Object.entries(siblings).every(([key, entry]) =>
          compatibleSibling(key, child[key], entry),
        )
      ) {
        return visit(mergeSiblings(child, siblings), active);
      }
    }
    const normalized = { ...value };
    if (
      typeof normalized.pattern === "string" &&
      Array.isArray(normalized.allOf) &&
      normalized.allOf.some(
        (child: unknown) =>
          record(child) && child.pattern === normalized.pattern,
      )
    )
      delete normalized.pattern;
    if (
      typeof normalized.minimum === "number" &&
      typeof normalized.exclusiveMinimum === "number" &&
      normalized.exclusiveMinimum >= normalized.minimum
    )
      delete normalized.minimum;
    if (
      typeof normalized.maximum === "number" &&
      typeof normalized.exclusiveMaximum === "number" &&
      normalized.exclusiveMaximum <= normalized.maximum
    )
      delete normalized.maximum;
    return normalizeStringIntersection(
      Object.fromEntries(
        Object.entries(normalized)
          .filter(([key]) => key !== "$defs" && key !== "definitions")
          .map(([key, child]) => {
            if (schemaMaps.has(key) && record(child))
              return [
                key,
                Object.fromEntries(
                  Object.entries(child).map(([name, schema]) => [
                    name,
                    visit(schema, active),
                  ]),
                ),
              ];
            if (schemaArrays.has(key) && Array.isArray(child))
              return [key, child.map((schema) => visit(schema, active))];
            if (schemaChildren.has(key))
              return [
                key,
                Array.isArray(child)
                  ? child.map((schema) => visit(schema, active))
                  : visit(child, active),
              ];
            return [key, child];
          }),
      ),
    );
  };
  return visit(root, new Set());
};
