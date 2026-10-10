import { isDeepStrictEqual } from "node:util";

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

const objectBranch = (
  root: Readonly<Record<string, unknown>>,
  branch: unknown,
): Readonly<Record<string, unknown>> | undefined => {
  // Reference siblings evaluate separately from the target in 2020-12, so a
  // merged object could accept inputs the branch rejects.
  const resolved =
    isObject(branch) && typeof branch.$ref === "string"
      ? Object.keys(branch).length === 1
        ? resolveReference(root, branch.$ref)
        : undefined
      : branch;
  return isObject(resolved) &&
    resolved.type === "object" &&
    isObject(resolved.properties)
    ? resolved
    : undefined;
};

const requiredProperties = (
  branch: Readonly<Record<string, unknown>>,
): readonly string[] =>
  Array.isArray(branch.required)
    ? branch.required.filter((name) => typeof name === "string")
    : [];

const sharedRequiredProperties = (
  branches: readonly Readonly<Record<string, unknown>>[],
): readonly string[] => {
  const [first = [], ...others] = branches.map(requiredProperties);
  return first.filter((name) => others.every((names) => names.includes(name)));
};

const inputGroup = (branch: Readonly<Record<string, unknown>>): string => {
  const required = requiredProperties(branch);
  const optional = Object.keys(branch.properties ?? {})
    .filter((name) => !required.includes(name))
    .map((name) => `[${name}]`);
  return [...required, ...optional].join(" + ");
};

// Anthropic tool input schemas reject anyOf, oneOf, and allOf at the root, and
// clients then drop the tool or advertise it without parameters. Present a
// root union of strict object groups as one object whose properties are the
// union of the groups. The canonical Zod schema still enforces the exact group.
const flattenRootObjectUnion = (
  root: Record<string, unknown>,
): Record<string, unknown> => {
  const { anyOf, oneOf, ...rest } = root;
  const alternatives = Array.isArray(anyOf) ? anyOf : oneOf;
  if (
    !Array.isArray(alternatives) ||
    alternatives.length === 0 ||
    root.properties !== undefined
  )
    return root;
  const branches = alternatives.map((branch) => objectBranch(root, branch));
  if (!branches.every((branch) => branch !== undefined)) return root;
  const variants = new Map<string, unknown[]>();
  for (const branch of branches)
    for (const [name, schema] of Object.entries(branch.properties ?? {})) {
      const known = variants.get(name) ?? [];
      if (!known.some((seen) => isDeepStrictEqual(seen, schema)))
        known.push(schema);
      variants.set(name, known);
    }
  const required = sharedRequiredProperties(branches);
  // A field unique to a group still needs that group's required partners.
  // Counting properties alone would let optional fields pad an incomplete pair.
  const dependencies = Object.fromEntries(
    [...variants.keys()].flatMap((name) => {
      const owners = branches.filter((branch) =>
        Object.hasOwn(branch.properties ?? {}, name),
      );
      const partners = sharedRequiredProperties(owners).filter(
        (partner) => partner !== name && !required.includes(partner),
      );
      return partners.length > 0 ? [[name, partners]] : [];
    }),
  );
  const fewestRequired = Math.min(
    ...branches.map((branch) => requiredProperties(branch).length),
  );
  // Groups that differ only in property values add no caller guidance.
  const groups = [...new Set(branches.map(inputGroup))];
  const description = [
    typeof rest.description === "string" ? rest.description : undefined,
    groups.length > 1
      ? `Provide a complete input group: ${groups.join("; ")}.`
      : undefined,
  ].filter((text) => text !== undefined);
  return {
    ...rest,
    type: "object",
    ...(description.length > 0 ? { description: description.join(" ") } : {}),
    properties: Object.fromEntries(
      [...variants].map(([name, schemas]) => [
        name,
        schemas.length === 1 ? schemas[0] : { anyOf: schemas },
      ]),
    ),
    ...(required.length > 0 ? { required } : {}),
    ...(fewestRequired > 0 ? { minProperties: fewestRequired } : {}),
    ...(Object.keys(dependencies).length > 0
      ? {
          [root.$schema === "http://json-schema.org/draft-07/schema#"
            ? "dependencies"
            : "dependentRequired"]: dependencies,
        }
      : {}),
    ...(branches.every((branch) => branch.additionalProperties === false)
      ? { additionalProperties: false }
      : {}),
  };
};

/** Describe canonical input fields and present the root as one object. */
export const presentInputJsonSchema = (
  root: Record<string, unknown>,
  describeProperty: (property: string) => string,
): Record<string, unknown> => {
  const flattened = flattenRootObjectUnion(root);
  const described = describeSchema(flattened, flattened, describeProperty);
  return isObject(described) ? described : flattened;
};
