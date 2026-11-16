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
 * Incur advertises Zod's output view. Publish the input view so an argv token
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
