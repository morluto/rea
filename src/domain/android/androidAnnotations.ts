import { z } from "zod";
import { dexDescriptorSchema, dexTypeSchema } from "./dexTypes.js";

/** A class literal may name `void`, which is not a DEX field type. */
const annotationTypeSchema = z.union([dexTypeSchema, z.literal("V")]);

/**
 * One annotation element value as parsed from DEX. Wide and floating values keep
 * Java text. The shape is deliberately non-recursive: arrays hold scalars, and a
 * nested annotation is identified without its elements.
 */
const annotationScalarSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("null") }),
  z.strictObject({ type: z.literal("boolean"), value: z.boolean() }),
  z.strictObject({ type: z.literal("byte"), value: z.int() }),
  z.strictObject({ type: z.literal("short"), value: z.int() }),
  z.strictObject({ type: z.literal("char"), value: z.int() }),
  z.strictObject({ type: z.literal("int"), value: z.int() }),
  z.strictObject({ type: z.literal("long"), value: z.string() }),
  z.strictObject({ type: z.literal("float"), value: z.string() }),
  z.strictObject({ type: z.literal("double"), value: z.string() }),
  z.strictObject({
    type: z.literal("string"),
    value: z.string(),
    /** Present only when `value` is a prefix; `length` is then the original UTF-16 length. */
    truncated: z.literal(true).exactOptional(),
    length: z.int().nonnegative().exactOptional(),
  }),
  z.strictObject({ type: z.literal("type"), value: annotationTypeSchema }),
  z.strictObject({
    type: z.literal("enum"),
    declaring_type: dexTypeSchema,
    name: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("field"),
    declaring_type: dexTypeSchema,
    name: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("method"),
    declaring_type: dexTypeSchema,
    name: z.string().min(1),
    dex_descriptor: dexDescriptorSchema,
  }),
  z.strictObject({
    type: z.literal("annotation"),
    dex_type: dexTypeSchema,
    element_count: z.int().nonnegative(),
    elements_omitted: z.literal(true),
  }),
  /** A value kind the engine did not decode; the kind is reported, never guessed. */
  z.strictObject({ type: z.literal("unsupported"), jadx_type: z.string() }),
]);

export const androidAnnotationValueSchema = z.union([
  annotationScalarSchema,
  z.strictObject({
    type: z.literal("array"),
    /** Total encoded items; `items` can be shorter when the bound was reached. */
    item_count: z.int().nonnegative(),
    items: z.array(annotationScalarSchema),
  }),
]);

/** A DEX annotation with its declared retention; no framework meaning is inferred. */
export const androidAnnotationSchema = z.strictObject({
  dex_type: dexTypeSchema,
  /** DEX visibility: `runtime` is reflection-visible, `build` is class-retention, `system` is toolchain metadata. */
  visibility: z.enum(["build", "runtime", "system"]),
  elements: z.array(
    z.strictObject({
      name: z.string().min(1),
      value: androidAnnotationValueSchema,
    }),
  ),
  /**
   * Present only when this annotation lost a fact to a bound (elements, array items,
   * string length) or holds an undecoded value. Absence means everything was kept.
   */
  truncated: z.literal(true).exactOptional(),
});

/** Annotations of one parameter, by DEX parameter index (the implicit receiver is not counted). */
export const androidParameterAnnotationsSchema = z.strictObject({
  index: z.int().nonnegative(),
  annotations: z.array(androidAnnotationSchema).min(1),
  /** Annotations beyond the per-member bound that are not listed. */
  annotations_omitted: z.int().positive().exactOptional(),
});

export type AndroidAnnotation = z.infer<typeof androidAnnotationSchema>;
export type AndroidParameterAnnotations = z.infer<
  typeof androidParameterAnnotationsSchema
>;
