import { z } from "zod";
import { dexDescriptorSchema } from "./dexTypes.js";

const count = z.int().nonnegative().safe();

/** The most classes complete delivery lists inline. */
export const ANDROID_KOTLIN_METADATA_INLINE_ROWS = 500;
/** The most classes a retained inventory can hold; a 4 MiB byte allowance may stop earlier. */
export const ANDROID_KOTLIN_METADATA_RETAINED_ROWS = 100_000;
/** Rows listed when the caller selects no limit. */
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
    .max(ANDROID_KOTLIN_METADATA_RETAINED_ROWS)
    .optional()
    .describe(
      `Maximum listed classes (default ${ANDROID_KOTLIN_METADATA_DEFAULT_ROWS}). Complete detail lists at most ${ANDROID_KOTLIN_METADATA_INLINE_ROWS}; detail summary retains up to ${ANDROID_KOTLIN_METADATA_RETAINED_ROWS} within a 4 MiB allowance and defaults to that maximum`,
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

/** Class-name prefixes counted as candidate markers, with their stable labels. */
export const ANDROID_KOTLIN_CLASS_PREFIXES = [
  { marker: "compose", prefix: "androidx.compose." },
  { marker: "kotlinx_coroutines", prefix: "kotlinx.coroutines." },
  { marker: "kotlin_coroutines", prefix: "kotlin.coroutines." },
] as const;
/** Most kotlin_module file names listed; the count always covers every entry. */
export const ANDROID_KOTLIN_MODULE_NAME_LIMIT = 64;

/**
 * Static candidates only: file names in the APK ZIP directory and class-name
 * prefixes in root DEX members. They never establish runtime use, a library
 * version, or that nothing else is present.
 */
export const androidKotlinMarkersSchema = z.strictObject({
  basis: z.literal("candidate-static-markers"),
  kotlin_module_entries: z.strictObject({
    /** Root META-INF/*.kotlin_module entries; their contents are not read. */
    count: count,
    names: z.array(z.string()).max(ANDROID_KOTLIN_MODULE_NAME_LIMIT),
    /** True when some entries are counted but not named (limit or name length). */
    truncated: z.boolean(),
  }),
  class_prefixes: z.array(
    z.strictObject({
      marker: z.enum(
        ANDROID_KOTLIN_CLASS_PREFIXES.map((entry) => entry.marker) as [
          (typeof ANDROID_KOTLIN_CLASS_PREFIXES)[number]["marker"],
          ...(typeof ANDROID_KOTLIN_CLASS_PREFIXES)[number]["marker"][],
        ],
      ),
      prefix: z.string(),
      /** Examined classes whose name starts with the prefix, with or without metadata. */
      classes: count,
    }),
  ),
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
  markers: androidKotlinMarkersSchema,
  unknowns: z.array(z.string()),
});

export type AndroidKotlinMetadataFacts = z.infer<
  typeof androidKotlinMetadataFactsSchema
>;
export type AndroidKotlinMetadataSelection = z.infer<
  typeof androidKotlinMetadataSelectionSchema
>;
