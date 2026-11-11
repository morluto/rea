import { z } from "zod";

const hexAddress = z.string().regex(/^0x[a-f0-9]+$/u);
const offset = z.number().int().min(0);

/** One `LC_ENCRYPTION_INFO(_64)` command with its fields as recorded. */
export const machoEncryptionCommandSchema = z.object({
  kind: z.enum(["LC_ENCRYPTION_INFO", "LC_ENCRYPTION_INFO_64"]),
  index: offset.describe("Load-command index within the slice."),
  cmdsize: offset,
  cryptoff: offset
    .nullable()
    .describe(
      "File offset of the range from the start of the slice; null when cmdsize is too short to hold it.",
    ),
  cryptsize: offset.nullable(),
  cryptid: offset
    .nullable()
    .describe(
      "Encryption system identifier as recorded; loader.h defines 0 as not encrypted.",
    ),
  pad: offset
    .nullable()
    .describe("LC_ENCRYPTION_INFO_64 padding word; null for the 32-bit form."),
});

const fragmentSchema = z.object({
  slice_start: offset,
  slice_end: offset,
  segment: z
    .string()
    .nullable()
    .describe("File-backed segment holding these bytes; null when unmapped."),
  vm_start: hexAddress
    .nullable()
    .describe(
      "VM address of slice_start; null when unmapped or when the segment has no VM size.",
    ),
  vm_end: hexAddress.nullable(),
});

const mappingSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("mapped"),
    fragments: z.array(fragmentSchema),
    sections: z
      .array(z.object({ segment: z.string(), section: z.string() }))
      .describe(
        "File-backed sections the range overlaps; zero-fill and empty sections are excluded.",
      ),
  }),
  z.object({ status: z.literal("unknown"), reason: z.string() }),
]);

/** The range one encryption command names, in every coordinate it maps to. */
export const machoEncryptedRangeSchema = z.object({
  content: z
    .enum(["ciphertext", "plaintext"])
    .describe(
      "ciphertext when cryptid is nonzero; analysis derived from those bytes does not describe program code.",
    ),
  slice_start: offset,
  slice_end: offset.describe(
    "Exclusive end offset from the start of the slice.",
  ),
  container_start: offset,
  container_end: offset.describe(
    "Exclusive end offset from the start of the input file.",
  ),
  mapping: mappingSchema,
});

export const machoEncryptionStatusSchema = z.enum([
  "encrypted",
  "not-encrypted",
  "absent",
  "malformed",
  "unknown",
]);

const malformedKinds = ["structure", "duplicate-commands"] as const;
const malformedKind = z
  .enum(malformedKinds)
  .nullable()
  .describe(
    "Malformed cause owned by the structural reader; duplicate-commands means every encryption command was structurally valid. Null for all other statuses.",
  );

const sliceEncryptionFields = {
  architecture: z
    .string()
    .nullable()
    .describe(
      "lipo slice name matched by CPU type, subtype and offset; null when unmatched.",
    ),
  cpu_type: offset.nullable(),
  cpu_subtype: offset.nullable(),
  container_file_offset: offset,
  size: offset,
  status: machoEncryptionStatusSchema.describe(
    "absent only when every load command was read; malformed and unknown carry a reason.",
  ),
  malformed_kind: malformedKind,
  reason: z.string().nullable(),
  commands: z
    .array(machoEncryptionCommandSchema)
    .describe(
      "Encryption load commands in table order; a completed slice with more than two keeps the first two and states the total count in reason. Structural failures identify the invalid command, including commands beyond the retained pair.",
    ),
  range: machoEncryptedRangeSchema.nullable(),
};

const validateMalformedKind = (
  slice: { status: string; malformed_kind?: string | null | undefined },
  context: z.RefinementCtx,
): void => {
  if (
    slice.malformed_kind !== undefined &&
    (slice.status === "malformed") !== (slice.malformed_kind !== null)
  )
    context.addIssue({
      code: "custom",
      path: ["malformed_kind"],
      message: "A malformed cause is required exactly when status is malformed",
    });
};

/** Load-command encryption state of one newly inspected Mach-O slice. */
export const machoSliceEncryptionSchema = z
  .object(sliceEncryptionFields)
  .superRefine(validateMalformedKind);

/** View rows also report when a historical malformed cause was not recorded. */
export const machoSliceEncryptionViewSchema = z
  .strictObject({
    ...sliceEncryptionFields,
    malformed_kind: z
      .enum([...malformedKinds, "unrecorded"])
      .nullable()
      .describe(
        "Structural cause or duplicate-command ambiguity. Unrecorded means the historical inspection did not classify the cause. Null for other statuses.",
      ),
  })
  .superRefine(validateMalformedKind);

/** Interpret earlier slice records without inferring a cause from their command count. */
export const retainedMachoSliceEncryptionSchema = z
  .object({
    ...sliceEncryptionFields,
    malformed_kind: malformedKind.exactOptional(),
  })
  .superRefine(validateMalformedKind)
  .transform((slice): z.output<typeof machoSliceEncryptionViewSchema> => ({
    ...slice,
    malformed_kind:
      slice.malformed_kind === undefined
        ? slice.status === "malformed"
          ? "unrecorded"
          : null
        : slice.malformed_kind,
  }));

export type MachoEncryptionCommand = z.infer<
  typeof machoEncryptionCommandSchema
>;
export type MachoEncryptedRange = z.infer<typeof machoEncryptedRangeSchema>;
export type MachoSliceEncryption = z.infer<typeof machoSliceEncryptionSchema>;

/** Every slice's encryption state, or why the file could not be enumerated. */
export type MachoEncryptionFacts =
  | { readonly status: "not-mach-o" }
  | {
      readonly status: "malformed" | "unsupported";
      readonly reason: string;
    }
  | {
      readonly status: "parsed";
      readonly slices: readonly MachoSliceEncryption[];
    };
