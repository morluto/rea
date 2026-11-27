import { z } from "zod";
import { nativeMetadataRecoverySchema } from "./nativeMetadataRecovery.js";
import {
  DEFAULT_GHIDRA_TYPE_DECLARATIONS_MAX_UTF16,
  MAXIMUM_GHIDRA_TYPE_DECLARATIONS_MAX_UTF16,
  MINIMUM_GHIDRA_C_TEXT_UTF16,
} from "../analysisResourceLimits.js";

/** Select a database type by exact category path or a defined typed data address. */
export const nativeDataTypeInputSchema = z
  .strictObject({
    type: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
    document: z.string().optional(),
  })
  .refine(
    (value) => (value.type === undefined) !== (value.address === undefined),
    "Supply exactly one of type or address",
  );
/** C definitions of the types a caller adds to the analysis database. */
export const nativeDataTypeDefinitionsInputSchema = z.strictObject({
  declarations: z
    .string()
    .min(1)
    .describe(
      "C struct, union, enum and typedef definitions, e.g. `struct session { int id; char name[32]; struct session *next; };`. Members may use earlier definitions and existing database types.",
    ),
  declarations_max_utf16: z
    .int()
    .min(MINIMUM_GHIDRA_C_TEXT_UTF16)
    .max(MAXIMUM_GHIDRA_TYPE_DECLARATIONS_MAX_UTF16)
    .optional()
    .describe(
      `Longest declarations text to parse, in UTF-16 code units (default ${String(DEFAULT_GHIDRA_TYPE_DECLARATIONS_MAX_UTF16)}); the C parser cannot be cancelled`,
    ),
});

/** A pure qualifier in caller C text, which Ghidra's types cannot record. */
export const droppedCQualifierSchema = z.strictObject({
  qualifier: z.enum(["const", "volatile", "restrict", "__unaligned", "__w64"]),
  line: z.int().positive(),
  column: z.int().positive().describe("UTF-16 column in the caller's text"),
});

/** Present only when the caller's text held qualifiers that were not recorded. */
export const droppedCQualifiersDescription =
  "Qualifiers in the caller's text (const, volatile, restrict, __unaligned, __w64) that Ghidra has no representation for and did not record; absent when there were none";

/** Readback of each type one atomic definition call stored or found unchanged. */
export const nativeDataTypeDefinitionsSchema = z.strictObject({
  types: z
    .array(
      z.strictObject({
        id: z
          .string()
          .min(1)
          .describe("Category path for inspect_native_data_type"),
        name: z.string().min(1),
        kind: z.enum(["struct", "union", "enum", "typedef"]),
        size_bytes: z.int().nonnegative().nullable(),
        status: z
          .enum(["defined", "unchanged"])
          .describe(
            "unchanged: an equivalent caller-defined type already existed",
          ),
      }),
    )
    .min(1),
  dropped_qualifiers: z
    .array(droppedCQualifierSchema)
    .min(1)
    .optional()
    .describe(droppedCQualifiersDescription),
  effects: z.strictObject({
    scope: z.literal("session-analysis-database"),
    source_bytes_modified: z.literal(false),
  }),
});

/** Types and component identities remain analysis database observations. */
export const nativeDataTypeSchema = z.strictObject({
  status: z.enum(["available", "unavailable"]),
  reason: z.string().nullable(),
  id: z.string().nullable(),
  name: z.string().nullable(),
  kind: z.enum([
    "struct",
    "union",
    "enum",
    "pointer",
    "array",
    "typedef",
    "scalar",
    "unsupported",
    "unavailable",
  ]),
  source: z
    .enum(["analysis-database", "caller-defined"])
    .describe(
      "caller-defined: stored by define_native_data_types under /rea_caller_defined, not recovered by analysis. analysis-database: every other origin.",
    ),
  source_archive: z.string().nullable(),
  address: z.string().nullable(),
  size_bytes: z.int().nonnegative().nullable(),
  alignment_bytes: z.int().positive().nullable(),
  packing_enabled: z.boolean().nullable(),
  referenced_type: z.string().nullable(),
  array_count: z.int().nonnegative().nullable(),
  array_stride_bytes: z.int().nonnegative().nullable(),
  fields: z.array(
    z.strictObject({
      ordinal: z.int().nonnegative(),
      name: z.string().nullable(),
      offset_bytes: z.int().nonnegative(),
      size_bytes: z.int().nonnegative().nullable(),
      type_id: z.string(),
      bit_size: z.int().nonnegative().nullable(),
      bit_offset: z.int().nonnegative().nullable(),
      bit_field: z
        .strictObject({
          base_type_id: z.string(),
          declared_bit_size: z.int().nonnegative(),
          component_type_lookup: z.enum([
            "equivalent",
            "different",
            "not-found",
          ]),
          base_type_lookup: z.enum(["equivalent", "different", "not-found"]),
        })
        .optional()
        .describe(
          "Observed bit-field base and exact manager lookups. bit_size is the effective width; bit_offset is the least-significant-bit offset within the base type. Omission means bit-field details were not reported.",
        ),
      status: z.enum(["observed", "unsupported"]),
      flexible_tail: z.literal("unknown"),
    }),
  ),
  members: z.array(z.strictObject({ name: z.string(), value: z.string() })),
  total_fields: z.int().nonnegative(),
  truncated: z.boolean(),
  limitations: z.array(z.string()),
  metadata_recovery: nativeMetadataRecoverySchema.optional(),
});
