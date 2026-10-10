import {
  schemaArrays,
  schemaChildren,
  schemaMaps,
} from "./inputSchemaPresentation.js";

// Function-calling APIs such as Moonshot's validate the literal serialized
// size of each tool's parameters schema without expanding references. The
// compact profile renders the same validation rules within that budget by
// dropping annotation prose and sharing repeated subschemas through
// schema-local references, which those validators do not expand.

/** Annotation keys that carry guidance but no validation semantics. */
const annotationKeys = new Set(["description", "examples", "default", "title"]);

/** Keys whose values are literal data, never nested schemas to rewrite. */
const dataKeys = new Set(["const", "enum", "examples", "default"]);

/** Subschemas smaller than this cost more as a reference than inline. */
const minimumSharedBytes = 256;

export type AdvertisedInputSchemaPresentation = "shared" | "reduced";

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

const isShareCandidate = (node: Record<string, unknown>): boolean =>
  !("$ref" in node) && serializedBytes(node) >= minimumSharedBytes;

/**
 * Replace repeated annotation-free subschemas with schema-local references.
 * Definitions are named in deterministic first-replacement order, reuse
 * existing equivalent definitions, and can never form reference cycles
 * because a new definition is only referenced from positions that already
 * existed when it was created.
 */
const shareRepeatedSubschemas = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  const occurrences = new Map<string, number>();
  const count = (node: unknown, isRoot: boolean): void => {
    if (isSchemaObject(node) && !isRoot && isShareCandidate(node)) {
      const key = JSON.stringify(node);
      occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
    }
    rebuildSchemaPositions(node, (child) => {
      count(child, false);
      return child;
    });
  };
  count(schema, true);
  const repeated = new Set(
    [...occurrences]
      .filter(([, occurrenceCount]) => occurrenceCount >= 2)
      .map(([key]) => key),
  );
  if (repeated.size === 0) return schema;

  const existingDefinitions = new Map(
    Object.entries(
      isSchemaObject(schema.$defs)
        ? (schema.$defs as Record<string, unknown>)
        : {},
    )
      .filter(([, value]) => isSchemaObject(value))
      .map(([name, value]) => [JSON.stringify(value), name]),
  );
  const sharedDefinitions: Record<string, unknown> = {};
  const namesByKey = new Map<string, string>();
  // `node` is a schema or scalar, never a property/definition map: maps are
  // only ever traversed through their parent's recognized schema keys.
  const rebuildWithSharing = (
    node: unknown,
    protectedDefinition: boolean,
  ): unknown => {
    const rebuilt = rebuildSchemaPositions(node, (child) =>
      rebuildWithSharing(child, false),
    );
    if (
      !protectedDefinition &&
      isSchemaObject(rebuilt) &&
      isShareCandidate(rebuilt) &&
      repeated.has(JSON.stringify(rebuilt))
    ) {
      const key = JSON.stringify(rebuilt);
      const existing = existingDefinitions.get(key);
      if (existing !== undefined) return { $ref: `#/$defs/${existing}` };
      let name = namesByKey.get(key);
      if (name === undefined) {
        name = `shared${namesByKey.size}`;
        namesByKey.set(key, name);
        sharedDefinitions[name] = rebuilt;
      }
      return { $ref: `#/$defs/${name}` };
    }
    return rebuilt;
  };
  // Direct root definition values are the shared targets other positions
  // reference; replacing one with a reference to itself would recurse.
  const rebuiltRoot: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (schemaMaps.has(key) && isSchemaObject(value)) {
      rebuiltRoot[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          rebuildWithSharing(child, key === "$defs"),
        ]),
      );
      continue;
    }
    if (schemaArrays.has(key) && Array.isArray(value)) {
      rebuiltRoot[key] = value.map((child) => rebuildWithSharing(child, false));
      continue;
    }
    if (schemaChildren.has(key)) {
      rebuiltRoot[key] = Array.isArray(value)
        ? value.map((child) => rebuildWithSharing(child, false))
        : rebuildWithSharing(value, false);
      continue;
    }
    rebuiltRoot[key] = value;
  }
  if (Object.keys(sharedDefinitions).length === 0) return rebuiltRoot;
  return {
    ...rebuiltRoot,
    $defs: {
      ...(isSchemaObject(rebuiltRoot.$defs)
        ? (rebuiltRoot.$defs as Record<string, unknown>)
        : {}),
      ...sharedDefinitions,
    },
  };
};

const detectedType = (schema: unknown): string | undefined => {
  if (!isSchemaObject(schema)) return undefined;
  if (typeof schema.type === "string") return schema.type;
  const alternatives = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : [];
  for (const branch of alternatives) {
    if (isSchemaObject(branch) && typeof branch.type === "string")
      return branch.type;
  }
  return undefined;
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
      const type = detectedType(value);
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
 * keywords, references, and the canonical contract are preserved; only
 * annotation prose and, for structurally oversized schemas, nested
 * validation detail leave the advertised form.
 */
export const compactAdvertisedInputSchema = (
  schema: Record<string, unknown>,
  budgetBytes: number,
): CompactedInputSchema => {
  const shared = shareRepeatedSubschemas(stripAnnotations(schema));
  if (serializedBytes(shared) <= budgetBytes)
    return { schema: shared, presentation: "shared" };
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
