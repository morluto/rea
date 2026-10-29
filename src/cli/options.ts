import { z } from "incur";

import {
  executableFormatHintSchema,
  type ExecutableFormatHint,
} from "../domain/dosCom.js";
import type { BinaryArchitecture } from "../domain/binaryTargetTypes.js";
import {
  binaryArchitectureSchema,
  rawBinaryBaseAddressSchema,
  rawBinaryEntryPointSchema,
  rawBinaryVectorTableAddressSchema,
  type NativeLoadSelection,
} from "../domain/rawBinary.js";
import {
  architectureVariantSchema,
  type ArchitectureVariant,
} from "../domain/architectureVariant.js";
import { analysisProviderSelectorSchema } from "../domain/providerSelection.js";
import type { AnalysisProviderSelector } from "../domain/providerSelection.js";
import type { Logger } from "pino";

/** Parse decimal integer tokens before Number coercion can erase their syntax. */
export const cliIntegerArgument = (min: number) =>
  z
    .string()
    .regex(/^[0-9]+$/u, "Expected a decimal integer")
    .pipe(z.coerce.number<string>().safe().min(min));

export const providerSelectionOption = analysisProviderSelectorSchema
  .optional()
  .describe(
    "Bind deep analysis to a provider ID or use deterministic auto selection",
  );

/** Optional path to the local analysis snapshot loaded or updated by a command. */
export const snapshotSelectionOption = z
  .string()
  .min(1)
  .optional()
  .describe("Load and update a local analysis snapshot");

/** Explicit interpretation for headerless native executable formats. */
export const formatSelectionOption = executableFormatHintSchema
  .optional()
  .describe(
    "Explicit interpretation: dos-com or raw-binary (headerless), or gamecube-dol (GameCube/Wii DOL, never auto-detected); omission preserves header-based detection",
  );

export const architectureSelectionOption = binaryArchitectureSchema
  .optional()
  .describe(
    "Caller-supplied CPU family; required with --target-format raw-binary, must be omitted with gamecube-dol",
  );

export const entryPointSelectionOption = rawBinaryEntryPointSchema
  .optional()
  .describe(
    "Caller-supplied code entry address (0xhex), also the load address without --base-address; required with --target-format raw-binary unless --architecture-variant is given, optional with gamecube-dol (must equal the DOL header entry)",
  );

export const baseAddressSelectionOption = rawBinaryBaseAddressSchema
  .optional()
  .describe(
    "Address of raw file offset 0 (0xhex), separate from --entry-point; only with --architecture-variant",
  );

export const architectureVariantSelectionOption = architectureVariantSchema
  .optional()
  .describe(
    "ARM M-profile variant of a raw image, decoded in Thumb state; requires --architecture arm and --base-address",
  );

export const vectorTableAddressSelectionOption =
  rawBinaryVectorTableAddressSchema
    .optional()
    .describe(
      "Address of the M-profile vector table (0xhex) when --entry-point is omitted and the table is not at --base-address",
    );

/** Shared CLI flags that bind a native target interpretation. */
export const nativeOpenOptionFields = {
  "target-format": formatSelectionOption,
  architecture: architectureSelectionOption,
  "entry-point": entryPointSelectionOption,
  "base-address": baseAddressSelectionOption,
  "architecture-variant": architectureVariantSelectionOption,
  "vector-table-address": vectorTableAddressSelectionOption,
  provider: providerSelectionOption,
};

/** Native CLI flags consumed when opening a target for one-shot analysis. */
export interface NativeOpenCliFlags {
  readonly snapshot?: string | undefined;
  readonly provider?: AnalysisProviderSelector | undefined;
  readonly "target-format"?: ExecutableFormatHint | undefined;
  readonly architecture?: BinaryArchitecture | undefined;
  readonly "entry-point"?: string | undefined;
  readonly "base-address"?: string | undefined;
  readonly "architecture-variant"?: ArchitectureVariant | undefined;
  readonly "vector-table-address"?: string | undefined;
}

/** Collect the native load flags into the selection that target admission owns. */
export const nativeLoadSelectionFromCli = (
  options: NativeOpenCliFlags,
): NativeLoadSelection => ({
  ...(options["target-format"] === undefined
    ? {}
    : { format: options["target-format"] }),
  ...(options.architecture === undefined
    ? {}
    : { architecture: options.architecture }),
  ...(options["entry-point"] === undefined
    ? {}
    : { entryPoint: options["entry-point"] }),
  ...(options["base-address"] === undefined
    ? {}
    : { baseAddress: options["base-address"] }),
  ...(options["architecture-variant"] === undefined
    ? {}
    : { architectureVariant: options["architecture-variant"] }),
  ...(options["vector-table-address"] === undefined
    ? {}
    : { vectorTableAddress: options["vector-table-address"] }),
});

/** Map native CLI flags onto the shared one-shot analysis options. */
export const directAnalysisOptionsFromCli = (
  logger: Logger,
  options: NativeOpenCliFlags,
) => ({
  logger,
  snapshotPath: options.snapshot,
  loadSelection: nativeLoadSelectionFromCli(options),
  ...(options.provider === undefined ? {} : { providerId: options.provider }),
});
