import { z } from "zod";
import { knownCoverageStatusSchema } from "../coverage.js";
import { constants as bufferConstants } from "node:buffer";
import {
  parameterBudgetLimit,
  type ParameterBudget,
} from "../parameterBudget.js";

const kind = z.enum(["func", "table", "memory", "global", "tag", "unknown"]);
const valueType = z.enum([
  "i32",
  "i64",
  "f32",
  "f64",
  "v128",
  "funcref",
  "externref",
]);
const limit = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const signature = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("func"),
    params: z.array(valueType),
    results: z.array(valueType),
  }),
  z.object({
    kind: z.literal("tag"),
    params: z.array(valueType),
    results: z.array(valueType),
  }),
  z.object({
    kind: z.literal("table"),
    element: z.enum(["funcref", "externref"]),
    address_type: z.enum(["i32", "i64"]),
    minimum: limit,
    maximum: limit.nullable(),
    shared: z.boolean(),
  }),
  z.object({
    kind: z.literal("memory"),
    page_size: limit,
    address_type: z.enum(["i32", "i64"]),
    minimum: limit,
    maximum: limit.nullable(),
    shared: z.boolean(),
  }),
  z.object({
    kind: z.literal("global"),
    value_type: valueType,
    mutable: z.boolean(),
  }),
]);

/** Typed observations decoded once at the WABT producer boundary. */
export const wasmInterfaceSchema = z.object({
  state: knownCoverageStatusSchema,
  entries: z.array(
    z
      .object({
        direction: z.enum(["import", "export"]),
        module: z.string().nullable(),
        name: z.string(),
        kind,
        index: z.int().nonnegative().max(0xffff_ffff).nullable(),
        signature: signature.nullable(),
        wat_form: z.string(),
        issue: z.string().nullable(),
      })
      .superRefine((entry, context) => {
        if (
          (entry.direction === "export" && entry.module !== null) ||
          (entry.direction === "import" && entry.module === null)
        )
          context.addIssue({
            code: "custom",
            message: "Interface direction does not match module-name presence",
          });
        if (entry.signature !== null && entry.signature.kind !== entry.kind)
          context.addIssue({
            code: "custom",
            message: "Interface kind does not match its typed signature",
          });
      }),
  ),
  issues: z.array(z.string()),
});
export type WasmInterface = z.infer<typeof wasmInterfaceSchema>;
export type WasmInterfaceEntry = WasmInterface["entries"][number];
export type WasmInterfaceSignature = NonNullable<
  WasmInterfaceEntry["signature"]
>;

export type WasmInterfaceValueType = z.infer<typeof valueType>;

/** Bound eager typed output and repeated signature expansion independently of WAT bytes. */
export const DEFAULT_WASM_INTERFACE_REPRESENTATION_BYTES = 32 * 1024 * 1024;
export const MAX_WASM_INTERFACE_REPRESENTATION_BYTES =
  bufferConstants.MAX_STRING_LENGTH;
/** Per-call typed WASM interface budget shared by the input schema and refusal limit. */
export const WASM_INTERFACE_BYTE_BUDGET: ParameterBudget = {
  minimum: 1,
  maximum: MAX_WASM_INTERFACE_REPRESENTATION_BYTES,
  default_value: DEFAULT_WASM_INTERFACE_REPRESENTATION_BYTES,
  unit: "bytes",
};
/** Build a structured per-call refusal limit using the input schema's own bounds. */
export const wasmInterfaceByteBudgetLimit = (effectiveValue: number) =>
  parameterBudgetLimit(
    "max_interface_bytes",
    WASM_INTERFACE_BYTE_BUDGET,
    effectiveValue,
  );
export const wasmInterfaceByteBudgetSchema = z
  .number()
  .int()
  .min(WASM_INTERFACE_BYTE_BUDGET.minimum)
  .max(WASM_INTERFACE_BYTE_BUDGET.maximum)
  .exactOptional()
  .describe(
    `Typed interface representation admission in bytes (default ${String(WASM_INTERFACE_BYTE_BUDGET.default_value)}, range ${String(WASM_INTERFACE_BYTE_BUDGET.minimum)}..${String(WASM_INTERFACE_BYTE_BUDGET.maximum)}; maximum follows the runtime string ceiling). Applies on the next inspection or comparison without restart. Raising this does not restore facts omitted from previously produced partial Evidence; inspect again with a larger producer budget first.`,
  );

/** Conservative JSON/retention charge; shared arrays still expand at every occurrence. */
export const wasmInterfaceEntryRepresentationBytes = (
  entry: WasmInterfaceEntry,
): number => {
  let bytes =
    1024 +
    [entry.module, entry.name, entry.wat_form, entry.issue].reduce<number>(
      (sum, value) => sum + (value?.length ?? 0) * 6,
      0,
    );
  const signature = entry.signature;
  if (signature?.kind === "func" || signature?.kind === "tag")
    bytes += (signature.params.length + signature.results.length) * 16;
  else if (signature !== null)
    for (const value of Object.values(signature))
      if (typeof value === "string") bytes += value.length * 6;
  return bytes;
};
