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
      const merged = { ...referenced, ...siblings };
      for (const [key, entry] of Object.entries(siblings)) {
        const previous = referenced[key];
        if (
          previous === undefined ||
          JSON.stringify(previous) === JSON.stringify(entry)
        )
          continue;
        if (typeof previous === "number" && typeof entry === "number") {
          if (lowerBounds.has(key)) {
            merged[key] = Math.max(previous, entry);
            continue;
          }
          if (upperBounds.has(key)) {
            merged[key] = Math.min(previous, entry);
            continue;
          }
        }
        throw new Error(`Conflicting schema reference sibling: ${key}`);
      }
      return visit(merged, new Set([...active, reference]));
    }
    if (Array.isArray(value.allOf) && value.allOf.length === 1) {
      const child = visit(value.allOf[0], active);
      const { allOf: _allOf, ...siblings } = value;
      if (
        record(child) &&
        !Object.keys(siblings).some((key) => scopedKeywords.has(key)) &&
        Object.entries(siblings).every(
          ([key, entry]) =>
            child[key] === undefined ||
            JSON.stringify(child[key]) === JSON.stringify(entry) ||
            (typeof child[key] === "number" &&
              typeof entry === "number" &&
              (lowerBounds.has(key) || upperBounds.has(key))),
        )
      ) {
        const merged = { ...child, ...siblings };
        for (const [key, entry] of Object.entries(siblings)) {
          const previous = child[key];
          if (typeof previous !== "number" || typeof entry !== "number")
            continue;
          if (lowerBounds.has(key)) merged[key] = Math.max(previous, entry);
          else if (upperBounds.has(key))
            merged[key] = Math.min(previous, entry);
        }
        return visit(merged, active);
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
    return Object.fromEntries(
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
    );
  };
  return visit(root, new Set());
};
