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

/** Zero or more free decimal digits after a fixed digit. */
const freeTail = (length: number): string =>
  length === 0 ? "" : `[0-9]{${length}}`;

/**
 * Pattern for fixed-length decimal spellings at least `floor`. Leading zeros
 * are significant here: the spelling has exactly `floor.length` digits.
 */
const atLeastPattern = (floor: string): string => {
  const parts: string[] = [];
  let prefix = "";
  for (let index = 0; index < floor.length; index += 1) {
    const digit = Number(floor.charAt(index));
    if (digit < 9)
      parts.push(`${prefix}[${digit + 1}-9]${freeTail(floor.length - index - 1)}`);
    prefix += floor.charAt(index);
  }
  parts.push(floor);
  return parts.length === 1 ? (parts[0] ?? "") : `(?:${parts.join("|")})`;
};

/**
 * Pattern for fixed-length decimal spellings at most `ceiling`. Leading zeros
 * are significant here: the spelling has exactly `ceiling.length` digits.
 */
const atMostPattern = (ceiling: string): string => {
  const parts: string[] = [];
  let prefix = "";
  for (let index = 0; index < ceiling.length; index += 1) {
    const digit = Number(ceiling.charAt(index));
    if (digit > 0)
      parts.push(`${prefix}[0-${digit - 1}]${freeTail(ceiling.length - index - 1)}`);
    prefix += ceiling.charAt(index);
  }
  parts.push(ceiling);
  return parts.length === 1 ? (parts[0] ?? "") : `(?:${parts.join("|")})`;
};

/** Pattern for fixed-length decimal spellings in a same-length [lo, hi] range. */
const fixedLengthRangePattern = (lo: string, hi: string): string => {
  if (lo === hi) return lo;
  if (lo.length === 1) return `[${lo}-${hi}]`;
  let prefix = "";
  for (let index = 0; index < lo.length; index += 1) {
    const loDigit = Number(lo[index]);
    const hiDigit = Number(hi[index]);
    if (loDigit === hiDigit) {
      prefix += lo.charAt(index);
      continue;
    }
    const rest = lo.length - index - 1;
    const parts = [
      `${prefix}${loDigit}${atLeastPattern(lo.slice(index + 1))}`,
    ];
    if (hiDigit - loDigit > 1)
      parts.push(`${prefix}[${loDigit + 1}-${hiDigit - 1}]${freeTail(rest)}`);
    parts.push(`${prefix}${hiDigit}${atMostPattern(hi.slice(index + 1))}`);
    return `(?:${parts.join("|")})`;
  }
  return lo;
};

/** Pattern for canonical decimal spellings (no leading zeros, except "0") of integers in [lo, hi]. */
const canonicalRangePattern = (lo: number, hi: number): string => {
  const loText = String(lo);
  const hiText = String(hi);
  if (loText.length === hiText.length)
    return fixedLengthRangePattern(loText, hiText);
  const parts = [
    fixedLengthRangePattern(loText, "9".repeat(loText.length)),
  ];
  for (let length = loText.length + 1; length < hiText.length; length += 1)
    parts.push(`[1-9][0-9]{${length - 1}}`);
  parts.push(
    fixedLengthRangePattern(`1${"0".repeat(hiText.length - 1)}`, hiText),
  );
  return `(?:${parts.join("|")})`;
};

/**
 * Pattern for argv decimal tokens whose value lies in [lo, hi]. Leading zeros
 * stay decimal, so any run of them may precede the canonical spelling. The
 * runtime parser enforces the same bounds through the domain field; this
 * pattern only carries them into the advertised schema, where JSON Schema
 * `minimum`/`maximum` cannot constrain a string.
 */
export const boundedDecimalTokenPattern = (lo: number, hi: number): string =>
  `^(?:0*(?:${canonicalRangePattern(lo, hi)}))$`;

const isJsonSchemaRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Integer bounds a sibling schema branch declares, if both ends are present. */
const integerBranchBounds = (
  branch: unknown,
): { readonly lo: number; readonly hi: number } | undefined => {
  if (
    !isJsonSchemaRecord(branch) ||
    (branch.type !== "integer" && branch.type !== "number")
  )
    return undefined;
  const loRaw =
    typeof branch.minimum === "number"
      ? branch.minimum
      : typeof branch.exclusiveMinimum === "number"
        ? branch.exclusiveMinimum + 1
        : undefined;
  const hiRaw =
    typeof branch.maximum === "number"
      ? branch.maximum
      : typeof branch.exclusiveMaximum === "number"
        ? branch.exclusiveMaximum - 1
        : undefined;
  if (loRaw === undefined || hiRaw === undefined) return undefined;
  // Tokens spell non-negative integers only; a negative floor admits every token.
  const lo = Math.max(0, Math.ceil(loRaw));
  const hi = Math.floor(hiRaw);
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo > hi)
    return undefined;
  return { lo, hi };
};

/**
 * Bound the decimal-token string branch of every numeric union with the bounds
 * its sibling integer branch advertises. A union without declared bounds keeps
 * the unbounded token pattern; the runtime parser still owns those bounds.
 */
const boundDecimalTokenPatterns = (schema: unknown): void => {
  if (Array.isArray(schema)) {
    for (const entry of schema) boundDecimalTokenPatterns(entry);
    return;
  }
  if (!isJsonSchemaRecord(schema)) return;
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    const bounds = branches
      .map(integerBranchBounds)
      .find((entry) => entry !== undefined);
    if (bounds === undefined) continue;
    const pattern = boundedDecimalTokenPattern(bounds.lo, bounds.hi);
    for (const branch of branches)
      if (
        isJsonSchemaRecord(branch) &&
        branch.type === "string" &&
        branch.pattern === DECIMAL_INTEGER_TOKEN.source
      )
        branch.pattern = pattern;
  }
  for (const value of Object.values(schema)) boundDecimalTokenPatterns(value);
};

type DecimalWrapper =
  | { readonly kind: "default"; readonly value: number | null }
  | { readonly kind: "prefault"; readonly value: number | null }
  | {
      readonly kind: "optional" | "exactOptional" | "nullable" | "readonly";
    };

const decimalToken = (domain: z.ZodNumber) =>
  z
    .string()
    .regex(DECIMAL_INTEGER_TOKEN, "Expected a decimal integer")
    .pipe(z.coerce.number<string>())
    .pipe(domain);

const unwrapSchema = (field: { unwrap: () => unknown }): z.ZodType =>
  field.unwrap() as z.ZodType;

/**
 * Incur advertises Zod's output view. Publish the input view so an argv token
 * grammar that transforms text survives `--schema` and other SDK conversions.
 * The string branch also carries the domain bounds in its pattern: JSON Schema
 * `minimum`/`maximum` do not constrain strings, so without this a client
 * validating raw argv text would admit out-of-range tokens the parser rejects.
 */
export const publishArgvInput = <Field extends z.ZodType>(
  field: Field,
): Field => {
  const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(field, {
    io: "input",
  });
  boundDecimalTokenPatterns(inputSchema);
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
  return publishArgvInput(described) as z.ZodType<z.output<Field>>;
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
