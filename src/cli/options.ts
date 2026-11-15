import { z } from "zod";

import { OPEN_BINARY_TOOL_CONTRACT } from "../contracts/sessionToolContracts.js";
import type { CliSessionTarget } from "./contractCliDescription.js";

/** Decimal integer argv text. Leading zeros stay decimal; `0x` and exponent spellings do not. */
const DECIMAL_INTEGER_TOKEN = /^[0-9]+$/u;

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
 * Command schemas advertise Zod's output view. Publish the input view so an argv token
 * grammar that transforms text survives `--schema` and other SDK conversions.
 */
export const publishArgvInput = <Field extends z.ZodType>(
  field: Field,
): Field => {
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
      readonly elementNumber: z.ZodNumber;
      readonly wrappers: readonly DecimalWrapper[];
      readonly description: string | undefined;
    }
  | undefined => {
  const stack = unwrapWrappers(field);
  if (!(stack.core instanceof z.ZodArray)) return undefined;
  const elementStack = unwrapWrappers(stack.core.element as z.ZodType);
  if (!(elementStack.core instanceof z.ZodNumber)) return undefined;
  return {
    core: stack.core as z.ZodArray<z.ZodType>,
    elementNumber: elementStack.core,
    wrappers: stack.wrappers,
    description: stack.description,
  };
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
 * For an array of numbers, parses each token element while preserving the
 * array's bounds (e.g. minItems), cardinality, and optionality.
 */
export const cliDecimalField = <Field extends z.ZodType>(
  field: Field,
): z.ZodType<z.output<Field>> => {
  const numeric = numericStack(field);
  if (numeric !== undefined) {
    const admitted = applyDecimalWrappers(
      z.union([numeric.core, decimalToken(numeric.core)]),
      numeric.wrappers,
    );
    const described =
      numeric.description === undefined
        ? admitted
        : admitted.describe(numeric.description);
    return publishArgvInput(described) as z.ZodType<z.output<Field>>;
  }
  const array = arrayStack(field);
  if (array !== undefined) {
    const tokenElement = z.union([
      array.elementNumber,
      decimalToken(array.elementNumber),
    ]);
    let arraySchema: z.ZodArray<z.ZodType> = z.array(tokenElement);
    const checks = array.core._def.checks;
    if (Array.isArray(checks) && checks.length > 0) {
      arraySchema = arraySchema.check(...(checks as never[]));
    }
    const admitted = applyDecimalWrappers(arraySchema, array.wrappers);
    const described =
      array.description === undefined
        ? admitted
        : admitted.describe(array.description);
    return publishArgvInput(described) as z.ZodType<z.output<Field>>;
  }
  throw new Error(
    `cliDecimalField expected a numeric or numeric array domain field, received ${field.constructor.name}`,
  );
};

/** Adapt each numeric property of a shared shape; other properties stay unchanged. */
export const cliDecimalShape = <Shape extends Record<string, z.ZodType>>(
  shape: Shape,
): Shape =>
  Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [
      key,
      numericStack(field) === undefined && arrayStack(field) === undefined
        ? field
        : cliDecimalField(field),
    ]),
  ) as Shape;

/** Help of the flags that bind a native target interpretation. */
const NATIVE_OPEN_HELP = {
  format:
    "Explicit interpretation: dos-com or raw-binary (headerless), or gamecube-dol (GameCube/Wii DOL, never auto-detected); omission preserves header-based detection",
  architecture:
    "Caller-supplied CPU family; required with --target-format raw-binary, must be omitted with gamecube-dol",
  entryPoint:
    "Caller-supplied load and entry address (0xhex); required with --target-format raw-binary, optional with gamecube-dol (must equal the DOL header entry)",
  provider:
    "Bind deep analysis to a provider ID or use deterministic auto selection",
  snapshot: "Load and update a local analysis snapshot",
} as const;

/**
 * A native executable opened as an MCP client opens it, with `open_binary`'s
 * format, architecture, entry point and provider fields. An operation that
 * loads and updates an analysis snapshot also takes `snapshot_path`, with
 * `snapshot` as its help when it differs from the shared one.
 */
export const nativeTarget = (
  description: string,
  snapshot?: true | string,
): CliSessionTarget => ({
  description,
  open: {
    contract: OPEN_BINARY_TOOL_CONTRACT,
    fields: {
      ...(snapshot === undefined
        ? {}
        : {
            snapshot_path: {
              name: "snapshot",
              callerPath: true,
              description:
                snapshot === true ? NATIVE_OPEN_HELP.snapshot : snapshot,
            },
          }),
      format: {
        name: "target-format",
        values: ["dos-com", "raw-binary", "gamecube-dol"],
        description: NATIVE_OPEN_HELP.format,
      },
      architecture: { description: NATIVE_OPEN_HELP.architecture },
      entry_point: {
        name: "entry-point",
        description: NATIVE_OPEN_HELP.entryPoint,
      },
      provider_id: { name: "provider", description: NATIVE_OPEN_HELP.provider },
    },
  },
});
