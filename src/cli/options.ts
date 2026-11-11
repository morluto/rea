import { z } from "incur";
import { localPathStringSchema } from "../domain/localPath.js";

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

/** Decimal integer argv text. Leading zeros stay decimal; `0x` and exponent spellings do not. */
const DECIMAL_INTEGER_TOKEN = /^[0-9]+$/u;

type DecimalWrapper =
  | { readonly kind: "default"; readonly value: number | null }
  | { readonly kind: "prefault"; readonly value: number | null }
  | {
      readonly kind: "optional" | "exactOptional" | "nullable" | "readonly";
    };

/** Parse decimal integer tokens before Number coercion can erase their syntax. */
export const cliIntegerArgument = (min: number) =>
  z
    .string()
    .regex(DECIMAL_INTEGER_TOKEN, "Expected a decimal integer")
    .pipe(z.coerce.number<string>().safe().min(min));

const decimalToken = (domain: z.ZodNumber) =>
  z
    .string()
    .regex(DECIMAL_INTEGER_TOKEN, "Expected a decimal integer")
    .pipe(z.coerce.number<string>())
    .pipe(domain);

const unwrapSchema = (field: { unwrap: () => unknown }): z.ZodType =>
  field.unwrap() as z.ZodType;

/**
 * Incur advertises Zod's output view. Publish the input view so the decimal
 * token guard survives `--schema` and other SDK conversions.
 */
const publishDecimalInput = (field: z.ZodType): z.ZodType => {
  const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(field, {
    io: "input",
  });
  return field.meta(inputSchema);
};

const numericStack = (
  field: z.ZodType,
):
  | {
      readonly core: z.ZodNumber;
      readonly wrappers: readonly DecimalWrapper[];
      readonly description: string | undefined;
    }
  | undefined => {
  const wrappers: DecimalWrapper[] = [];
  let description: string | undefined;
  let current = field;
  for (;;) {
    if (description === undefined && current.description !== undefined)
      description = current.description;
    if (current instanceof z.ZodDefault) {
      wrappers.push({
        kind: "default",
        value: current.parse(undefined) as number | null,
      });
      current = unwrapSchema(current);
      continue;
    }
    if (current instanceof z.ZodPrefault) {
      wrappers.push({
        kind: "prefault",
        value: current.parse(undefined) as number | null,
      });
      current = unwrapSchema(current);
      continue;
    }
    if (current instanceof z.ZodOptional) {
      wrappers.push({ kind: "optional" });
      current = unwrapSchema(current);
      continue;
    }
    if (current instanceof z.ZodExactOptional) {
      wrappers.push({ kind: "exactOptional" });
      current = unwrapSchema(current);
      continue;
    }
    if (current instanceof z.ZodNullable) {
      wrappers.push({ kind: "nullable" });
      current = unwrapSchema(current);
      continue;
    }
    if (current instanceof z.ZodReadonly) {
      wrappers.push({ kind: "readonly" });
      current = unwrapSchema(current);
      continue;
    }
    break;
  }
  return current instanceof z.ZodNumber
    ? { core: current, wrappers, description }
    : undefined;
};

const applyDecimalWrappers = (
  field: z.ZodType,
  wrappers: readonly DecimalWrapper[],
): z.ZodType => {
  let admitted = field;
  for (const wrapper of wrappers.toReversed()) {
    if (wrapper.kind === "nullable") admitted = admitted.nullable();
    else if (wrapper.kind === "optional") admitted = admitted.optional();
    else if (wrapper.kind === "exactOptional")
      admitted = admitted.exactOptional();
    else if (wrapper.kind === "readonly") admitted = admitted.readonly();
    else if (wrapper.kind === "prefault")
      admitted = admitted.prefault(wrapper.value as never);
    else if (wrapper.kind === "default")
      admitted = admitted.default(wrapper.value as never);
  }
  return admitted;
};

/**
 * Parse a decimal token, then let the domain field own bounds, defaults,
 * nullability and help. JSON numbers remain valid for schema consumers.
 */
export const cliDecimalField = <Field extends z.ZodType>(
  field: Field,
): z.ZodType<z.output<Field>> => {
  const numeric = numericStack(field);
  if (numeric === undefined)
    throw new Error(
      `cliDecimalField expected a numeric domain field, received ${field.constructor.name}`,
    );
  const admitted = applyDecimalWrappers(
    z.union([numeric.core, decimalToken(numeric.core)]),
    numeric.wrappers,
  );
  const described =
    numeric.description === undefined
      ? admitted
      : admitted.describe(numeric.description);
  return publishDecimalInput(described) as z.ZodType<z.output<Field>>;
};

/** Adapt each numeric property of a shared shape; other properties stay unchanged. */
export const cliDecimalShape = <Shape extends Record<string, z.ZodType>>(
  shape: Shape,
): Shape =>
  Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [
      key,
      numericStack(field) === undefined ? field : cliDecimalField(field),
    ]),
  ) as Shape;

export const providerSelectionOption = analysisProviderSelectorSchema
  .optional()
  .describe(
    "Bind deep analysis to a provider ID or use deterministic auto selection",
  );

/** Optional path to the local analysis snapshot loaded or updated by a command. */
export const snapshotSelectionOption = localPathStringSchema
  .optional()
  .describe("Load and update a local analysis snapshot");

/**
 * Explicit interpretation for headerless native executable formats. Flash
 * dumps take their offsets on the artifact commands instead.
 */
const formatSelectionOption = executableFormatHintSchema
  .exclude(["esp-flash-image"])
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
