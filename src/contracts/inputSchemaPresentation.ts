const schemaMaps = new Set([
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
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

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const resolveReference = (
  root: Readonly<Record<string, unknown>>,
  reference: string,
): unknown => {
  if (!reference.startsWith("#/")) return undefined;
  let value: unknown = root;
  for (const token of reference.slice(2).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isObject(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
};

const referencedDescription = (
  root: Readonly<Record<string, unknown>>,
  schema: Readonly<Record<string, unknown>>,
): string | undefined => {
  let value: unknown = schema;
  const active = new Set<string>();
  while (isObject(value)) {
    if (typeof value.description === "string") return value.description;
    if (typeof value.$ref !== "string" || active.has(value.$ref))
      return undefined;
    active.add(value.$ref);
    value = resolveReference(root, value.$ref);
  }
  return undefined;
};

const describeSchema = (
  schema: unknown,
  root: Readonly<Record<string, unknown>>,
  describeProperty: (property: string) => string,
): unknown => {
  if (!isObject(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (schemaMaps.has(key) && isObject(value))
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, child]) => {
              const described = describeSchema(child, root, describeProperty);
              return [
                name,
                key === "properties" && isObject(described)
                  ? {
                      ...described,
                      description:
                        referencedDescription(root, described) ??
                        describeProperty(name),
                    }
                  : described,
              ];
            }),
          ),
        ];
      if (schemaArrays.has(key) && Array.isArray(value))
        return [
          key,
          value.map((child) => describeSchema(child, root, describeProperty)),
        ];
      if (schemaChildren.has(key))
        return [
          key,
          Array.isArray(value)
            ? value.map((child) =>
                describeSchema(child, root, describeProperty),
              )
            : describeSchema(value, root, describeProperty),
        ];
      // Annotation values and literal const/enum data are not schemas.
      return [key, value];
    }),
  );
};

const flattenRootUnion = (
  value: Record<string, unknown>,
  describeProperty: (property: string) => string,
): Record<string, unknown> => {
  if (!Array.isArray(value.anyOf)) return value;
  const branches = value.anyOf;
  const objects = branches.filter(isObject);
  if (objects.length === 0 || objects.length !== branches.length) return value;
  const properties = new Map<string, unknown>();
  for (const branch of objects) {
    if (!isObject(branch.properties)) return value;
    for (const [name, schema] of Object.entries(branch.properties)) {
      const previous = properties.get(name);
      if (!properties.has(name)) properties.set(name, schema);
      else if (JSON.stringify(previous) !== JSON.stringify(schema))
        properties.set(name, {
          anyOf: [previous, schema],
          description: describeProperty(name),
        });
    }
  }
  // Invocation still uses the exact canonical union, including branch rules.
  const { anyOf: _anyOf, required: _required, ...root } = value;
  const requiredByBranch = objects.map((branch) =>
    Array.isArray(branch.required)
      ? branch.required.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  );
  const required = requiredByBranch.reduce((common, current) =>
    common.filter((name) => current.includes(name)),
  );
  const minProperties = Math.max(
    typeof root.minProperties === "number" ? root.minProperties : 0,
    Math.min(...requiredByBranch.map((names) => names.length)),
  );
  return {
    ...root,
    type: "object",
    properties: Object.fromEntries(properties),
    ...(minProperties > 0 ? { minProperties } : {}),
    ...(required.length > 0 ? { required } : {}),
    ...(objects.every((branch) => branch.additionalProperties === false)
      ? { additionalProperties: false }
      : {}),
  };
};

/** Preserve property guidance and literal data while advertising object roots. */
export const presentInputJsonSchema = (
  root: Record<string, unknown>,
  describeProperty: (property: string) => string,
): Record<string, unknown> => {
  const described = describeSchema(root, root, describeProperty);
  return isObject(described)
    ? flattenRootUnion(described, describeProperty)
    : root;
};
