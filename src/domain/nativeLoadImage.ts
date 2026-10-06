import { z } from "zod";
import { jsonValueSchema } from "./jsonValue.js";

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const hexBytes = z.string().regex(/^(?:[a-f0-9]{2})*$/u);
const address = z.string().min(1);

/** Measured provider image, without exporting the complete executable bytes. */
export const nativeLoadImageObservationSchema = z.strictObject({
  executable_format: z.string().min(1),
  language_id: z.string().min(1),
  compiler_spec_id: z.string().min(1),
  image_base: address,
  default_address_space: z.string().min(1),
  source_files: z.array(
    z.strictObject({
      name: z.string(),
      size: integer,
      original_sha256: digest,
      modified_sha256: digest,
    }),
  ),
  mappings: z.array(
    z.strictObject({
      block: z.string(),
      start: address,
      end: address,
      address_space: z.string().min(1),
      initialized: z.boolean(),
      loaded: z.boolean(),
      overlay: z.boolean(),
      length: integer.min(1),
      source_file_index: integer.nullable(),
      file_offset: integer.nullable(),
      sha256: digest.nullable(),
    }),
  ),
  relocations: z.array(
    z.strictObject({
      address,
      segment: integer.max(0xffff).nullable(),
      offset: integer.max(0xffff).nullable(),
      status: z.string().min(1),
      type: z.number().int(),
      values: z.array(
        z
          .number()
          .int()
          .min(Number.MIN_SAFE_INTEGER)
          .max(Number.MAX_SAFE_INTEGER),
      ),
      original_bytes_hex: hexBytes.nullable(),
      memory_bytes_hex: hexBytes.nullable(),
    }),
  ),
  entry_points: z.array(address),
});

/** Independent comparison, preserving both expectations and measured values. */
export const nativeLoadImageCheckSchema = z.strictObject({
  name: z.string().min(1),
  matched: z.boolean(),
  expected: jsonValueSchema,
  observed: jsonValueSchema,
  file_offset: integer.nullable(),
  address: address.nullable(),
});

/** Read-only native image verification; verified applies only to declared coverage. */
export const nativeLoadImageSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("unsupported"),
    reason: z.string().min(1),
    observations: nativeLoadImageObservationSchema,
    limitations: z.array(z.string().min(1)),
  }),
  z.strictObject({
    status: z.enum(["verified", "mismatch"]),
    format: z.literal("dos-mz"),
    target_sha256: digest,
    load_segment: integer.max(0xffff),
    header_bytes: integer,
    module_bytes: integer,
    overlay_bytes: integer,
    entry: z.strictObject({
      relative_segment: integer.max(0xffff),
      offset: integer.max(0xffff),
      linear_address: address,
    }),
    observations: nativeLoadImageObservationSchema,
    checks: z.array(nativeLoadImageCheckSchema),
    limitations: z.array(z.string().min(1)),
  }),
]);

/** Provider-neutral native load-image result. */
export type NativeLoadImage = z.infer<typeof nativeLoadImageSchema>;
/** Measured source mappings, bytes, relocations and entries. */
export type NativeLoadImageObservation = z.infer<
  typeof nativeLoadImageObservationSchema
>;
