import {
  executableFormatHintSchema,
  type ExecutableFormatHint,
} from "../domain/dosCom.js";
import { absoluteLocalPathStringSchema } from "../domain/localPath.js";
import {
  binaryArchitectureSchema,
  rawBinaryBaseAddressSchema,
  rawBinaryEntryPointSchema,
  rawBinarySelectionError,
  rawBinaryVectorTableAddressSchema,
  type NativeLoadSelection,
} from "../domain/rawBinary.js";
import { architectureVariantSchema } from "../domain/architectureVariant.js";
import { z } from "zod";
import {
  espFlashAddressSchema,
  espFlashSelectionError,
  parseEspFlashAddress,
} from "../domain/firmware/espFlashSelection.js";
import { analysisProviderSelectorSchema } from "../domain/providerSelection.js";

/** Caller-supplied analysis snapshot path; must name its destination absolutely. */
const snapshotPathSchema = absoluteLocalPathStringSchema.describe(
  "Absolute local filesystem path for the analysis snapshot; relative paths are rejected.",
);

/** Caller-supplied analysis target path; must name the target absolutely. */
const binaryTargetPathSchema = absoluteLocalPathStringSchema.describe(
  "Absolute local filesystem path for the analysis target; relative paths are rejected.",
);

/** Collect the open_binary load fields into the selection that target admission owns. */
export const openBinaryLoadSelection = (input: {
  readonly format?: ExecutableFormatHint | undefined;
  readonly architecture?: NativeLoadSelection["architecture"] | undefined;
  readonly entry_point?: string | undefined;
  readonly base_address?: string | undefined;
  readonly architecture_variant?:
    | NativeLoadSelection["architectureVariant"]
    | undefined;
  readonly vector_table_address?: string | undefined;
}): NativeLoadSelection => ({
  ...(input.format === undefined ? {} : { format: input.format }),
  ...(input.architecture === undefined
    ? {}
    : { architecture: input.architecture }),
  ...(input.entry_point === undefined ? {} : { entryPoint: input.entry_point }),
  ...(input.base_address === undefined
    ? {}
    : { baseAddress: input.base_address }),
  ...(input.architecture_variant === undefined
    ? {}
    : { architectureVariant: input.architecture_variant }),
  ...(input.vector_table_address === undefined
    ? {}
    : { vectorTableAddress: input.vector_table_address }),
});

/** Input contract for opening a target with an optional staged snapshot. */
export const openBinaryInputSchema = z
  .strictObject({
    path: binaryTargetPathSchema,
    format: executableFormatHintSchema
      .optional()
      .describe(
        "Explicit interpretation: dos-com or raw-binary (headerless), gamecube-dol (GameCube/Wii DOL, never auto-detected), or esp-flash-image (an ESP flash dump read with flash_offset and partition_table_offset). Omission preserves header-based detection.",
      ),
    architecture: binaryArchitectureSchema
      .optional()
      .describe(
        "Caller-supplied CPU family. Required with format=raw-binary; rejected otherwise. format=gamecube-dol takes powerpc from the header, so it must be omitted.",
      ),
    entry_point: rawBinaryEntryPointSchema
      .optional()
      .describe(
        "Caller-supplied code entry address (0xhex). Without base_address, file offset 0 is also mapped here. Required with format=raw-binary unless architecture_variant is given; rejected otherwise. Optional with format=gamecube-dol; must equal the DOL header entry.",
      ),
    base_address: rawBinaryBaseAddressSchema
      .optional()
      .describe(
        "Address of raw file offset 0 (0xhex), separate from entry_point. Only with architecture_variant.",
      ),
    architecture_variant: architectureVariantSchema
      .optional()
      .describe(
        "ARM M-profile variant of a raw image (raw dumps do not record it), decoded in Thumb state. Requires format=raw-binary, architecture=arm and base_address; an odd entry_point is refused.",
      ),
    vector_table_address: rawBinaryVectorTableAddressSchema
      .optional()
      .describe(
        "Address of the M-profile vector table (0xhex) when it is not at base_address, such as after a bootloader header. Only when entry_point is omitted.",
      ),
    flash_offset: espFlashAddressSchema
      .optional()
      .describe(
        "Flash address (0xhex) of the dump's first byte, when it does not start at flash address 0. Only with format=esp-flash-image.",
      ),
    partition_table_offset: espFlashAddressSchema
      .optional()
      .describe(
        "Flash address (0xhex, a multiple of 0x1000) of the partition table, which disables the table scan. Only with format=esp-flash-image.",
      ),
    provider_id: analysisProviderSelectorSchema.optional(),
    snapshot_path: snapshotPathSchema.optional(),
  })
  .superRefine((value, context) => {
    const flash = espFlashSelectionError({
      format: value.format,
      flashOffset:
        value.flash_offset === undefined
          ? undefined
          : parseEspFlashAddress(value.flash_offset),
      partitionTableOffset:
        value.partition_table_offset === undefined
          ? undefined
          : parseEspFlashAddress(value.partition_table_offset),
    });
    if (flash !== undefined)
      context.addIssue({
        code: "custom",
        path: [
          value.partition_table_offset === undefined
            ? "flash_offset"
            : "partition_table_offset",
        ],
        message: flash,
      });
    const pairing = rawBinarySelectionError(openBinaryLoadSelection(value));
    if (pairing === undefined) return;
    context.addIssue({
      code: "custom",
      path: [pairing.field],
      message: pairing.message,
    });
  });

/** Open only app resources when no declared executable is available. */
export const openBundleResourcesInputSchema = z.strictObject({
  path: binaryTargetPathSchema,
});

/** Input contract for closing a target after an optional atomic snapshot. */
export const closeBinaryInputSchema = z.strictObject({
  snapshot_path: snapshotPathSchema.optional(),
  overwrite: z.boolean().default(false),
});

/** Optional complete checkpoint before explicitly ending the current investigation. */
export const resetInvestigationInputSchema = z.strictObject({
  save_path: absoluteLocalPathStringSchema
    .describe(
      "Absolute path for a complete Evidence bundle saved before clearing records.",
    )
    .optional(),
  overwrite: z.boolean().default(false),
});
