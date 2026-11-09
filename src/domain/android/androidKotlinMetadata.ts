import { z } from "zod";
import { dexDescriptorSchema } from "./dexTypes.js";

const count = z.int().nonnegative().safe();

/** The most rows one request returns; the full inventory is counted, not listed. */
export const ANDROID_KOTLIN_METADATA_MAX_ROWS = 500;
/** Rows returned when the caller selects no limit. */
export const ANDROID_KOTLIN_METADATA_DEFAULT_ROWS = 100;

/** Caller selection; an exact class selects the one decoded declaration. */
export const androidKotlinMetadataSelectionSchema = z.strictObject({
  class_name: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Exact fully qualified class name; decodes that class's Kotlin declaration",
    ),
  package_prefix: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Class-name prefix selecting which classes are listed; histograms always cover every class",
    ),
  limit: z
    .int()
    .min(1)
    .max(ANDROID_KOTLIN_METADATA_MAX_ROWS)
    .optional()
    .describe(
      `Maximum listed classes (default ${ANDROID_KOTLIN_METADATA_DEFAULT_ROWS}, maximum ${ANDROID_KOTLIN_METADATA_MAX_ROWS})`,
    ),
});

/** The annotation's raw `k` value; unrecognized values are kept as "unknown". */
export const androidKotlinMetadataKindSchema = z.enum([
  "class",
  "file_facade",
  "synthetic_class",
  "multi_file_class_facade",
  "multi_file_class_part",
  "unknown",
]);

const typeFacts = z.strictObject({
  classifier: z.enum(["class", "type_alias", "type_parameter", "unknown"]),
  /** Kotlin internal name such as `kotlin/String`; absent when the classifier is unknown. */
  name: z.string().exactOptional(),
  nullable: z.boolean(),
});

const functionFacts = z.strictObject({
  name: z.string(),
  /** JVM name and prototype as the compiler recorded them; absent when not recorded. */
  jvm_name: z.string().exactOptional(),
  dex_descriptor: dexDescriptorSchema.exactOptional(),
  is_suspend: z.boolean(),
  is_inline: z.boolean(),
  is_operator: z.boolean(),
  receiver_type: typeFacts.exactOptional(),
  return_type: typeFacts,
});

const propertyFacts = z.strictObject({
  name: z.string(),
  is_var: z.boolean(),
  is_const: z.boolean(),
  receiver_type: typeFacts.exactOptional(),
  return_type: typeFacts,
});

/** Decoded only for the exact class the caller selected. */
export const androidKotlinDeclarationSchema = z.strictObject({
  class_kind: z.string().exactOptional(),
  modality: z.string().exactOptional(),
  visibility: z.string().exactOptional(),
  is_data: z.boolean().exactOptional(),
  is_value: z.boolean().exactOptional(),
  is_fun_interface: z.boolean().exactOptional(),
  is_inner: z.boolean().exactOptional(),
  name: z.string().exactOptional(),
  facade_class_name: z.string().exactOptional(),
  functions_total: count.exactOptional(),
  functions: z.array(functionFacts).exactOptional(),
  properties_total: count.exactOptional(),
  properties: z.array(propertyFacts).exactOptional(),
});

/** One class carrying a `kotlin.Metadata` annotation. */
export const androidKotlinClassSchema = z.strictObject({
  class_name: z.string().min(1),
  dex_entry: z.string().min(1),
  /**
   * Raw `k`; unrecognized values stay visible rather than being dropped. The raw
   * annotation facts below are absent when an element was malformed, in which
   * case `decode` is "undecodable" and `decode_failure` names the element.
   */
  metadata_kind: z.int().exactOptional(),
  kind: androidKotlinMetadataKindSchema.exactOptional(),
  /** Raw `mv`; also absent when the annotation carries none. */
  metadata_version: z.string().exactOptional(),
  package_name: z.string().exactOptional(),
  /** Raw `xi` bit set. */
  extra_int: z.int().exactOptional(),
  /** Number of `d1` strings and whether `d2` is present; the payload is not returned. */
  data_strings: count.exactOptional(),
  has_d2: z.boolean().exactOptional(),
  decode: z.enum(["not_requested", "decoded", "undecodable"]),
  decode_failure: z.string().exactOptional(),
  declaration: androidKotlinDeclarationSchema.exactOptional(),
});

/** Scope is standard root classes*.dex members, never runtime-loaded code. */
export const androidKotlinMetadataFactsSchema = z.strictObject({
  scope: z.literal("apk-root-dex-kotlin-metadata"),
  coverage: z.strictObject({
    status: z.enum(["complete", "partial"]),
    dex_entries: count,
    examined_dex_entries: count,
    examined_classes: count,
    classes_with_metadata: count,
    /** Annotations whose elements were malformed, plus a selected class that failed to decode. */
    undecodable_classes: count,
  }),
  versions: z.array(z.strictObject({ version: z.string(), classes: count })),
  kinds: z.array(
    z.strictObject({ kind: androidKotlinMetadataKindSchema, classes: count }),
  ),
  matching_classes: count,
  classes: z.array(androidKotlinClassSchema),
  unknowns: z.array(z.string()),
});

export type AndroidKotlinMetadataFacts = z.infer<
  typeof androidKotlinMetadataFactsSchema
>;
export type AndroidKotlinMetadataSelection = z.infer<
  typeof androidKotlinMetadataSelectionSchema
>;
