import { z } from "zod";

// Typed presentation annotations on canonical Zod schemas. The advertised
// schema presenter reads them by schema identity; they never enter the
// canonical JSON Schema, so runtime validation and every other projection of
// the schema are unchanged.

/** Presentation facts a canonical schema declares for its advertised form. */
export interface SchemaAnnotations {
  /**
   * Present this two-object root union as one object whose `if`/`then`/`else`
   * selects the alternative by this property's literal value.
   */
  readonly rootDiscriminator?: string;
  /**
   * This object is a complete producer result the caller passes back
   * unchanged. Its advertised form omits the repeated result fields and keeps
   * only its description plus that instruction; runtime validation still
   * parses the complete canonical observation.
   */
  readonly completeObservation?: true;
  /**
   * How a pattern-only JSON Schema declaration relates to the runtime
   * predicate it stands for: `exact` accepts the same strings, `wider` also
   * admits strings the predicate rejects. Declaration checks compare the
   * accepted sets accordingly.
   */
  readonly patternDeclaration?: "exact" | "wider";
  /**
   * Every alternative of this union is an object, so its advertised output
   * root also declares `type: "object"` for MCP codecs that read only the
   * root type.
   */
  readonly objectRoot?: true;
}

const annotations = z.registry<SchemaAnnotations>();

/** The annotations declared on this schema or the schema it was cloned from. */
export const schemaAnnotations = (
  schema: z.core.$ZodType,
): SchemaAnnotations | undefined => annotations.get(schema);

type ObjectAlternatives = readonly [z.core.$ZodObject, z.core.$ZodObject];

/**
 * Advertise a root union of two strict objects as one object keyed on
 * `discriminator`: the alternative requiring it, otherwise the other one.
 */
export const presentRootDiscriminator = <
  Schema extends z.ZodUnion<ObjectAlternatives>,
>(
  schema: Schema,
  discriminator: keyof z.input<Schema> & string,
): Schema => {
  annotations.add(schema, {
    ...annotations.get(schema),
    rootDiscriminator: discriminator,
  });
  return schema;
};

/**
 * Advertise a copy of `schema` as a complete producer result to pass back
 * unchanged. The shared result schema itself keeps its full advertised form
 * wherever else it appears, such as the producer's output schema.
 */
export const presentCompleteObservation = <Schema extends z.ZodType>(
  schema: Schema,
): Schema => {
  // The clone inherits the source's annotations and description.
  const annotated = schema.clone();
  annotations.add(annotated, { completeObservation: true });
  return annotated;
};

/**
 * Record how `schema`'s pattern-only declaration relates to its runtime
 * predicate. `schemaConstraints.ts` owns the declaration itself.
 */
export const annotatePatternDeclaration = <Schema extends z.ZodType>(
  schema: Schema,
  relation: "exact" | "wider",
): Schema => {
  annotations.add(schema, {
    ...annotations.get(schema),
    patternDeclaration: relation,
  });
  return schema;
};

type ObjectUnion =
  | z.ZodUnion<readonly z.core.$ZodObject[]>
  | z.ZodDiscriminatedUnion<readonly z.core.$ZodObject[]>;

/** Advertise an output union of objects with an object root type. */
export const presentObjectRoot = <Schema extends ObjectUnion>(
  schema: Schema,
): Schema => {
  annotations.add(schema, { ...annotations.get(schema), objectRoot: true });
  return schema;
};
