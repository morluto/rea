import {
  schemaArrays,
  schemaChildren,
  schemaMaps,
} from "./inputSchemaPresentation.js";

// Kimi expands schema-local references before sending tools to Moonshot.
// Compact advertisements must fit after expansion, independently of client
// reference handling. Canonical server-side validation remains unchanged.

/** Annotation keys that carry guidance but no validation semantics. */
const annotationKeys = new Set(["description", "examples", "default", "title"]);

/** Keys whose values are literal data, never nested schemas to rewrite. */
const dataKeys = new Set(["const", "enum", "examples", "default"]);
const definitionKeys = new Set(["$defs", "definitions"]);
// An empty schema accepts every JSON value. Kimi otherwise infers string.
const jsonValueTypes = [
  "null",
  "boolean",
  "object",
  "array",
  "number",
  "string",
];

export type AdvertisedInputSchemaPresentation = "inline" | "reduced";

export interface CompactedInputSchema {
  readonly schema: Record<string, unknown>;
  readonly presentation: AdvertisedInputSchemaPresentation;
}

const isSchemaObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const serializedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

/** Rewrite every schema-valued position; literal data stays opaque. */
const rebuildSchemaPositions = (
  node: unknown,
  rebuild: (child: unknown) => unknown,
): unknown => {
  if (Array.isArray(node)) return node.map((child) => rebuild(child));
  if (!isSchemaObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (dataKeys.has(key)) {
      out[key] = value;
      continue;
    }
    if (schemaMaps.has(key) && isSchemaObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, rebuild(child)]),
      );
      continue;
    }
    if (schemaArrays.has(key) && Array.isArray(value)) {
      out[key] = value.map((child) => rebuild(child));
      continue;
    }
    if (schemaChildren.has(key)) {
      out[key] = Array.isArray(value)
        ? value.map((child) => rebuild(child))
        : rebuild(value);
      continue;
    }
    out[key] = value;
  }
  return out;
};

/**
 * Drop annotation prose from every subschema while preserving all validation
 * keywords. The root keeps its own description because the root-union
 * projection encodes accepted input groups there; the root's echoed literal
 * examples leave with the rest of the annotation prose.
 */
const stripAnnotations = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  const rebuilt = rebuildSchemaPositions(
    schema,
    stripChildAnnotations,
  ) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rebuilt)) {
    if (annotationKeys.has(key) && key !== "description") continue;
    out[key] = value;
  }
  return out;
};

const stripChildAnnotations = (child: unknown): unknown => {
  const rebuilt = rebuildSchemaPositions(child, stripChildAnnotations);
  if (!isSchemaObject(rebuilt)) return rebuilt;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rebuilt))
    if (!annotationKeys.has(key)) kept[key] = value;
  return kept;
};

const resolveLocalReference = (
  root: Record<string, unknown>,
  reference: string,
): unknown => {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) return undefined;
  let value: unknown = root;
  for (const token of reference.slice(2).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isSchemaObject(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
};

/** Stop serialization at the budget before allocating an expanded schema. */
const inlineWithinBudget = (
  root: Record<string, unknown>,
  budgetBytes: number,
): Record<string, unknown> | undefined => {
  let resolved = true;
  function* serialize(
    value: unknown,
    position: "schema" | "map" | "data",
    active: ReadonlySet<string>,
  ): Generator<string> {
    if (Array.isArray(value)) {
      yield "[";
      for (const [index, child] of value.entries()) {
        if (index > 0) yield ",";
        yield* serialize(child, position, active);
      }
      yield "]";
    } else if (isSchemaObject(value)) {
      if (position === "schema" && Object.keys(value).length === 0) {
        yield JSON.stringify({ type: jsonValueTypes });
        return;
      }
      if (position === "schema" && typeof value.$ref === "string") {
        const target = resolveLocalReference(root, value.$ref);
        if (target === undefined || active.has(value.$ref)) {
          resolved = false;
          return;
        }
        const { $ref, ...siblings } = value;
        // Reference siblings are independent constraints in draft 2020-12.
        // Merging their keys into the target would overwrite validation rules.
        yield* serialize(
          Object.keys(siblings).length === 0
            ? target
            : { allOf: [target, siblings] },
          "schema",
          new Set([...active, $ref]),
        );
        return;
      }
      yield "{";
      let first = true;
      for (const [key, child] of Object.entries(value)) {
        if (position === "schema" && definitionKeys.has(key)) continue;
        if (!first) yield ",";
        first = false;
        yield JSON.stringify(key) + ":";
        const childPosition =
          position === "map"
            ? "schema"
            : position === "schema" && schemaMaps.has(key)
              ? "map"
              : position === "schema" &&
                  (schemaArrays.has(key) || schemaChildren.has(key))
                ? "schema"
                : "data";
        yield* serialize(child, childPosition, active);
      }
      yield "}";
    } else {
      yield JSON.stringify(value);
    }
  }
  const chunks: string[] = [];
  let bytes = 0;
  for (const chunk of serialize(root, "schema", new Set())) {
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > budgetBytes || !resolved) return undefined;
    chunks.push(chunk);
  }
  return resolved
    ? (JSON.parse(chunks.join("")) as Record<string, unknown>)
    : undefined;
};

/** Preserve every possible type, including referenced and nullable unions. */
const detectedTypes = (
  schema: unknown,
  root: Record<string, unknown>,
  active: ReadonlySet<string> = new Set(),
): readonly string[] | undefined => {
  if (!isSchemaObject(schema)) return undefined;
  if (typeof schema.$ref === "string") {
    if (active.has(schema.$ref)) return undefined;
    return detectedTypes(
      resolveLocalReference(root, schema.$ref),
      root,
      new Set([...active, schema.$ref]),
    );
  }
  if (typeof schema.type === "string") return [schema.type];
  if (
    Array.isArray(schema.type) &&
    schema.type.every((type) => typeof type === "string")
  )
    return schema.type;
  const alternatives = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : [];
  if (alternatives.length === 0) return undefined;
  const types = alternatives.map((branch) =>
    detectedTypes(branch, root, active),
  );
  if (types.some((type) => type === undefined)) return undefined;
  return [...new Set(types.flatMap((type) => type ?? []))];
};

const REDUCED_ANNOTATION =
  "Advertised in reduced form by the compact input schema profile; the server still validates complete canonical inputs.";

/**
 * Present only the root property shape with per-property guidance. Used for
 * schemas whose validation structure alone exceeds the compact budget; the
 * canonical schema still rejects malformed calls server-side.
 */
const reduceToShallowProperties = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  const properties = isSchemaObject(schema.properties) ? schema.properties : {};
  const description = [
    typeof schema.description === "string" ? schema.description : undefined,
    REDUCED_ANNOTATION,
  ]
    .filter((text) => text !== undefined)
    .join(" ");
  const $schema =
    typeof schema.$schema === "string" ? { $schema: schema.$schema } : {};
  const shallow = Object.fromEntries(
    Object.entries(properties).map(([name, value]) => {
      const types = detectedTypes(value, schema);
      const type = types?.length === 1 ? types[0] : types;
      const description =
        isSchemaObject(value) && typeof value.description === "string"
          ? { description: value.description }
          : {};
      return [
        name,
        { ...(type === undefined ? {} : { type }), ...description },
      ];
    }),
  );
  return {
    ...$schema,
    type: "object",
    description,
    properties: shallow,
    ...(Array.isArray(schema.required)
      ? { required: [...schema.required] }
      : {}),
    ...(typeof schema.minProperties === "number"
      ? { minProperties: schema.minProperties }
      : {}),
    ...(isSchemaObject(schema.dependentRequired)
      ? { dependentRequired: { ...schema.dependentRequired } }
      : {}),
    ...(schema.additionalProperties === false
      ? { additionalProperties: false }
      : {}),
  };
};

/**
 * Render an advertised input schema within a per-schema byte budget for
 * providers that validate the literal serialized schema size. Validation
 * keywords and the canonical contract are preserved; only
 * annotation prose and, for structurally oversized schemas, nested
 * validation detail leave the advertised form.
 */
export const compactAdvertisedInputSchema = (
  schema: Record<string, unknown>,
  budgetBytes: number,
): CompactedInputSchema => {
  const inline = inlineWithinBudget(stripAnnotations(schema), budgetBytes);
  if (inline !== undefined) return { schema: inline, presentation: "inline" };
  const reduced = reduceToShallowProperties(schema);
  if (serializedBytes(reduced) <= budgetBytes)
    return { schema: reduced, presentation: "reduced" };
  // A future contract with an extreme root-property count still advertises
  // an honest, budget-fitting shape instead of an oversized one.
  return {
    schema: reduceToShallowProperties({
      type: "object",
      description:
        (typeof schema.description === "string"
          ? `${schema.description} `
          : "") + REDUCED_ANNOTATION,
    }),
    presentation: "reduced",
  };
};
