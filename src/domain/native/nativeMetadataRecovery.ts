import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-f]+$/u);
const relatedType = z.strictObject({ address, type: z.string().nullable() });

/** Runtime-format metadata recovered in an analysis image, with explicit inference boundaries. */
export const nativeMetadataRecoverySchema = z.strictObject({
  format: z.literal("dotnet-nativeaot"),
  status: z.enum(["complete", "partial"]),
  header_address: address,
  format_major: z.number().int().nonnegative(),
  format_minor: z.number().int().nonnegative(),
  method_table_address: address,
  name_origin: z.enum(["generated", "inferred"]),
  original_name: z.null(),
  base_size_bytes: z.number().int().nonnegative(),
  related_type: relatedType.nullable(),
  interfaces: z.array(relatedType),
  virtual_slots: z.array(
    z.strictObject({
      slot: z.number().int().nonnegative(),
      slot_address: address,
      target_address: address.nullable(),
      procedure_name: z.string().nullable(),
      basis: z.literal("method-table-pointer"),
    }),
  ),
  derived_memory: z.strictObject({
    address,
    size_bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    file_offset: z.null(),
  }),
  diagnostics: z.array(z.string()),
  limitations: z.array(z.string()),
});

/** Discover a recovered runtime format and reusable type identities from the loaded image. */
export const nativeMetadataRecoverySummarySchema = z.strictObject({
  format: z.literal("dotnet-nativeaot"),
  status: z.enum(["complete", "partial", "not_applicable"]),
  reason: z.string().nullable(),
  analysis_artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  header_address: address.nullable(),
  discovery: z.enum(["symbol", "signature-heuristic"]).nullable(),
  format_major: z.number().int().nonnegative().nullable(),
  format_minor: z.number().int().nonnegative().nullable(),
  method_tables: z.number().int().nonnegative(),
  types: z.array(relatedType),
  derived_memory: nativeMetadataRecoverySchema.shape.derived_memory.nullable(),
  coverage: z
    .strictObject({
      frozen_object_candidates: z.number().int().nonnegative(),
      frozen_objects_annotated: z.number().int().nonnegative(),
      basis: z.literal(
        "rehydrated-pointer-candidates-and-committed-instance-types",
      ),
    })
    .nullable(),
  diagnostics: z.array(z.string()),
  limitations: z.array(z.string()),
});
