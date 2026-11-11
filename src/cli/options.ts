import { z } from "incur";
import { localPathStringSchema } from "../domain/localPath.js";

import {
  executableFormatHintSchema,
  type ExecutableFormatHint,
} from "../domain/dosCom.js";
import type { BinaryArchitecture } from "../domain/binaryTargetTypes.js";
import {
  binaryArchitectureSchema,
  rawBinaryEntryPointSchema,
} from "../domain/rawBinary.js";
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

/** A number field, or a set of non-negative integer literals such as Rizin's widths. */
type NumericCore = z.ZodNumber | z.ZodLiteral<number>;

const isNumericCore = (field: z.ZodType): field is NumericCore =>
  field instanceof z.ZodNumber ||
  (field instanceof z.ZodLiteral &&
    [...field.values].every(
      (value) =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    ));

/**
 * A literal set advertises its members as decimal tokens too, so the string
 * view of `--schema` admits only what the parser admits.
 */
const decimalTokenPattern = (
  domain: NumericCore,
): { readonly pattern: RegExp; readonly message: string } => {
  if (domain instanceof z.ZodNumber)
    return {
      pattern: DECIMAL_INTEGER_TOKEN,
      message: "Expected a decimal integer",
    };
  const members = [...domain.values];
  return {
    pattern: new RegExp(`^0*(?:${members.join("|")})$`, "u"),
    message: `Expected one of ${members.join(", ")}`,
  };
};

const decimalToken = (domain: NumericCore) => {
  const { pattern, message } = decimalTokenPattern(domain);
  return z
    .string()
    .regex(pattern, message)
    .pipe(z.coerce.number<string>())
    .pipe(domain);
};

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
      readonly core: NumericCore;
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
  return isNumericCore(current)
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
  const branches = [numeric.core, decimalToken(numeric.core)] as const;
  // Both branches reject a non-member of a literal set, and incur reports
  // only the union issue, so the union names the members.
  const admitted = applyDecimalWrappers(
    numeric.core instanceof z.ZodLiteral
      ? z.union(branches, {
          error: decimalTokenPattern(numeric.core).message,
        })
      : z.union(branches),
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
    "Caller-supplied load and entry address (0xhex); required with --target-format raw-binary, optional with gamecube-dol (must equal the DOL header entry)",
  );

/** Shared CLI flags that bind a native target interpretation. */
export const nativeOpenOptionFields = {
  "target-format": formatSelectionOption,
  architecture: architectureSelectionOption,
  "entry-point": entryPointSelectionOption,
  provider: providerSelectionOption,
};

/** Native CLI flags consumed when opening a target for one-shot analysis. */
export interface NativeOpenCliFlags {
  readonly snapshot?: string | undefined;
  readonly provider?: AnalysisProviderSelector | undefined;
  readonly "target-format"?: ExecutableFormatHint | undefined;
  readonly architecture?: BinaryArchitecture | undefined;
  readonly "entry-point"?: string | undefined;
}

/** Map native CLI flags onto the shared one-shot analysis options. */
export const directAnalysisOptionsFromCli = (
  logger: Logger,
  options: NativeOpenCliFlags,
) => ({
  logger,
  snapshotPath: options.snapshot,
  ...(options["target-format"] === undefined
    ? {}
    : { formatHint: options["target-format"] }),
  ...(options.architecture === undefined
    ? {}
    : { architecture: options.architecture }),
  ...(options["entry-point"] === undefined
    ? {}
    : { entryPoint: options["entry-point"] }),
  ...(options.provider === undefined ? {} : { providerId: options.provider }),
});
