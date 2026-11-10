import { z } from "incur";

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

const unwrapWrappers = (
  field: z.ZodType,
): {
  readonly core: z.ZodType;
  readonly wrappers: readonly DecimalWrapper[];
  readonly description: string | undefined;
} => {
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
  return { core: current, wrappers, description };
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
  const stack = unwrapWrappers(field);
  return stack.core instanceof z.ZodNumber
    ? {
        core: stack.core,
        wrappers: stack.wrappers,
        description: stack.description,
      }
    : undefined;
};

const arrayStack = (
  field: z.ZodType,
):
  | {
      readonly core: z.ZodArray<z.ZodType>;
      readonly wrappers: readonly DecimalWrapper[];
      readonly description: string | undefined;
    }
  | undefined => {
  const stack = unwrapWrappers(field);
  return stack.core instanceof z.ZodArray
    ? {
        core: stack.core as z.ZodArray<z.ZodType>,
        wrappers: stack.wrappers,
        description: stack.description,
      }
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

/**
 * Adapt a domain array of decimal integers for CLI argv options. Decimal
 * text tokens are parsed and coerced into the domain element schema, while the
 * array's bounds, cardinality, description, and optionality are derived from
 * the domain field. The outer schema remains a ZodArray for Incur's option parser.
 */
export const cliDecimalArrayField = <Field extends z.ZodType>(
  field: Field,
): z.ZodType<z.output<Field>> => {
  const stack = arrayStack(field);
  if (stack === undefined)
    throw new Error(
      `cliDecimalArrayField expected an array domain field, received ${field.constructor.name}`,
    );
  const element = stack.core.element;
  const tokenElement = z.union([
    element,
    z
      .string()
      .regex(DECIMAL_INTEGER_TOKEN, "Expected a decimal integer")
      .pipe(z.coerce.number<string>().safe())
      .pipe(element as never),
  ]);
  let arraySchema: z.ZodArray<z.ZodType> = z.array(tokenElement);
  const checks = stack.core._def.checks;
  if (Array.isArray(checks) && checks.length > 0) {
    arraySchema = arraySchema.check(...(checks as never[]));
  }
  const admitted = applyDecimalWrappers(arraySchema, stack.wrappers);
  const described =
    stack.description === undefined
      ? admitted
      : admitted.describe(stack.description);
  return publishDecimalInput(described) as z.ZodType<z.output<Field>>;
};

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
