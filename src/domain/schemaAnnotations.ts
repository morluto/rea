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
