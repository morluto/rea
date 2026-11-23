import { isRecord } from "../kernel/isRecord.js";
import {
  COMPACT_SCHEMA_MAX_DEPTH,
  inlineWithinBudget,
  isSchemaObject,
  jsonValueSchema,
  pruneSchemaBeyondDepth,
  reduceToShallowProperties,
  schemaDepth,
  serializedBytes,
} from "./compactJsonSchema.js";
import { JsonSchemaReferences } from "./jsonSchemaReferences.js";

// Output schemas dominate a complete `tools/list` frame. The compact profile
// bounds each advertised output contract so frame-capped hosts can finish the
// handshake, while canonical result validation and `structuredContent` stay
// unchanged. Every projection is a widening: a valid canonical result always
// satisfies the advertised schema.

export type AdvertisedOutputSchemaPresentation = "inline" | "reduced";

/** Budget selected by the caller for compact MCP output-schema presentation. */
export interface CompactOutputSchemaPresentation {
  readonly budgetBytes: number;
}

export interface CompactedOutputSchema {
  readonly schema: Record<string, unknown>;
  readonly presentation: AdvertisedOutputSchemaPresentation;
}

const OUTPUT_REDUCED_ANNOTATION =
  "Advertised in reduced form by the compact output schema profile; the server still validates complete canonical results.";

const COMPOSITION_KEYWORDS = ["oneOf", "anyOf", "allOf"] as const;
type CompositionKeyword = (typeof COMPOSITION_KEYWORDS)[number];

/** A root union or intersection whose members are schemas, when it has one. */
const compositionKeyword = (
  schema: Record<string, unknown>,
): CompositionKeyword | undefined =>
  COMPOSITION_KEYWORDS.find((keyword) => {
    const members = schema[keyword];
    return (
      Array.isArray(members) &&
      members.length > 0 &&
      members.every((member) => isSchemaObject(member))
    );
  });

/**
 * Follow one local `$ref`, the same hop SDK 2.4.0 uses when it decides a
 * typeless union is an object. An unresolved reference stays unknown so the
 * caller can keep a widening fallback.
 */
const resolvedCompositionMember = (
  member: Record<string, unknown>,
  references: JsonSchemaReferences,
): Record<string, unknown> | undefined => {
  if (typeof member.$ref !== "string") return member;
  const target = references.resolve(references.rootScope, member.$ref);
  return target.kind === "target" && isSchemaObject(target.value)
    ? target.value
    : undefined;
};

/**
 * Shallow-reduce one alternative. Its own root guidance stays; the composition
 * root carries the reduced-form notice once.
 */
const shallowCompositionMember = (
  member: Record<string, unknown>,
  references: JsonSchemaReferences,
): Record<string, unknown> | undefined => {
  const resolved = resolvedCompositionMember(member, references);
  if (resolved === undefined) return undefined;
  if (resolved.type !== "object" && !isSchemaObject(resolved.properties))
    return jsonValueSchema();
  const reduced = reduceToShallowProperties(
    resolved,
    OUTPUT_REDUCED_ANNOTATION,
    references,
  );
  const own =
    typeof resolved.description === "string" ? resolved.description : undefined;
  const { description: _description, ...shape } = reduced;
  return own === undefined ? shape : { ...shape, description: own };
};

/**
 * SDK 2.4.0 stamps `type: "object"` on a root that is only a `$ref` union of
 * objects. Reducing that root as a property bag drops the union and advertises
 * an empty object. Keep each alternative's root shape instead. Widened
 * `oneOf` branches can overlap, so they are advertised as `anyOf`; an exact
 * `oneOf` would reject a canonical result that matches more than one widened
 * branch.
 */
const reduceObjectComposition = (
  schema: Record<string, unknown>,
  keyword: CompositionKeyword,
  references: JsonSchemaReferences,
): Record<string, unknown> | undefined => {
  const members = schema[keyword];
  if (!Array.isArray(members)) return undefined;
  const reduced: Record<string, unknown>[] = [];
  for (const member of members) {
    if (!isSchemaObject(member)) return undefined;
    const shape = shallowCompositionMember(member, references);
    if (shape === undefined) return undefined;
    reduced.push(shape);
  }
  const description = [
    typeof schema.description === "string" ? schema.description : undefined,
    OUTPUT_REDUCED_ANNOTATION,
  ]
    .filter((text) => text !== undefined)
    .join(" ");
  return {
    ...(typeof schema.$schema === "string" ? { $schema: schema.$schema } : {}),
    ...(schema.type === "object" ? { type: "object" } : {}),
    ...(description === "" ? {} : { description }),
    [keyword === "allOf" ? "allOf" : "anyOf"]: reduced,
  };
};

/**
 * Drop the canonical contract's content-bound `$id` and anchors. The compact
 * bytes differ from the canonical schema the identity was derived from, so
 * retaining that identity would misstate what the advertised document is.
 * References are already inlined, so no identity is needed to resolve them.
 */
const withoutContentBoundIdentity = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  const { $id: _id, $anchor: _anchor, ...advertised } = schema;
  return advertised;
};

/**
 * Render an advertised output schema within a per-schema byte budget. The
 * complete validation structure is kept when it fits; otherwise the root
 * property shape and first-level types remain and nested detail is elided.
 * The registered canonical schema still validates every delivered result.
 */
export const compactAdvertisedOutputSchema = (
  schema: Record<string, unknown>,
  budgetBytes: number,
): CompactedOutputSchema => {
  const references = new JsonSchemaReferences(schema);
  const inline = inlineWithinBudget(schema, budgetBytes, {
    stripAnnotations: true,
    references,
  });
  if (inline !== undefined && schemaDepth(inline) <= COMPACT_SCHEMA_MAX_DEPTH)
    return {
      schema: withoutContentBoundIdentity(inline),
      presentation: "inline",
    };
  // An inlined schema that only exceeds the depth limit keeps every fitting
  // branch. Pruning returns nothing when widening a child under oneOf or not
  // could reject a valid result.
  if (inline !== undefined) {
    const pruned = pruneSchemaBeyondDepth(inline);
    if (
      pruned !== undefined &&
      schemaDepth(pruned) <= COMPACT_SCHEMA_MAX_DEPTH &&
      serializedBytes(pruned) <= budgetBytes
    )
      return {
        schema: withoutContentBoundIdentity(pruned),
        presentation: "inline",
      };
  }
  // SDK 2.4.0 stamps `type: "object"` on a `$ref` union before this projection
  // sees it. That union has no root `properties`; keep each alternative's
  // shape instead of the empty property bag. guided_workflows already
  // declared the same object root.
  const keyword =
    schema.type === "object" && !isSchemaObject(schema.properties)
      ? compositionKeyword(schema)
      : undefined;
  const composed =
    keyword === undefined
      ? undefined
      : reduceObjectComposition(schema, keyword, references);
  const composedSchema =
    composed === undefined ? undefined : withoutContentBoundIdentity(composed);
  if (
    composedSchema !== undefined &&
    serializedBytes(composedSchema) <= budgetBytes &&
    schemaDepth(composedSchema) <= COMPACT_SCHEMA_MAX_DEPTH
  )
    return { schema: composedSchema, presentation: "reduced" };
  // Every REA output contract is an object at the root. A non-object root still
  // advertises an accepting shape rather than a projection that could reject
  // valid canonical output.
  const reduced =
    schema.type === "object" || isSchemaObject(schema.properties)
      ? reduceToShallowProperties(schema, OUTPUT_REDUCED_ANNOTATION, references)
      : jsonValueSchema();
  if (serializedBytes(reduced) <= budgetBytes)
    return {
      schema: withoutContentBoundIdentity(reduced),
      presentation: "reduced",
    };
  // A root description can itself be large; keep the advertisement inside the
  // budget instead of carrying it into a shape with no nested detail left.
  const minimal = reduceToShallowProperties(
    { type: "object" },
    OUTPUT_REDUCED_ANNOTATION,
  );
  return {
    schema:
      serializedBytes(minimal) <= budgetBytes ? minimal : jsonValueSchema(),
    presentation: "reduced",
  };
};

const OBJECT_COMPOSITION_KEYS = ["oneOf", "anyOf", "allOf"] as const;
const LOCAL_DEFINITION_REF = /^#\/(\$defs|definitions)\/([^/~%]+)$/;

/**
 * Whether a typeless JSON Schema root is an object or a composition of
 * objects. This matches `@modelcontextprotocol/server` 2.4.0 `tools/list`,
 * which is not exported: a typeless object-shaped output root is stamped
 * `type: "object"`. A `$ref` is followed one hop into the root document's
 * `$defs` or `definitions` when that entry is `type: "object"`.
 */
const isObjectShapedOutputRoot = (
  schema: Record<string, unknown>,
  root: Record<string, unknown> = schema,
): boolean => {
  if (
    "properties" in schema ||
    "patternProperties" in schema ||
    "additionalProperties" in schema ||
    "required" in schema
  )
    return true;
  if (typeof schema.$ref === "string") {
    const match = LOCAL_DEFINITION_REF.exec(schema.$ref);
    const group = match?.[1];
    const name = match?.[2];
    const definitions = group === undefined ? undefined : root[group];
    const target =
      name !== undefined && isRecord(definitions)
        ? definitions[name]
        : undefined;
    if (isRecord(target) && target.type === "object") return true;
  }
  for (const key of OBJECT_COMPOSITION_KEYS) {
    const members = schema[key];
    if (Array.isArray(members) && members.length > 0)
      return members.every(
        (member) =>
          isRecord(member) &&
          (member.type === "object" ||
            isObjectShapedOutputRoot(member, "$id" in member ? {} : root)),
      );
  }
  return false;
};

/**
 * The output JSON Schema `tools/list` emits before REA compacts it.
 * A schema that already has `type` is unchanged. A typeless root that is
 * provably object-shaped gains `type: "object"`, which is what the SDK lists
 * for a discriminated union of objects.
 */
export const listedOutputJsonSchema = (
  schema: Record<string, unknown>,
): Record<string, unknown> =>
  schema.type !== undefined || !isObjectShapedOutputRoot(schema)
    ? schema
    : { type: "object", ...schema };

/** Return the JSON schema clients receive for the selected output presentation. */
export const presentAdvertisedOutputSchema = (
  schema: Record<string, unknown>,
  compactPresentation: CompactOutputSchemaPresentation | undefined,
): Record<string, unknown> =>
  compactPresentation === undefined
    ? schema
    : compactAdvertisedOutputSchema(schema, compactPresentation.budgetBytes)
        .schema;
