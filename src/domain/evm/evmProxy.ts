import { z } from "zod";

import { absoluteLocalPathStringSchema } from "../localPath.js";
import {
  parameterBudgetLimitFor,
  parameterBudgetSchema,
  type ParameterBudget,
} from "../parameterBudget.js";

/** The per-call budgets of `inspect_evm_proxy`. */
const EVM_PROXY_BUDGETS = {
  max_file_bytes: {
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    default_value: 4 * 1024 * 1024,
    unit: "bytes",
  },
} as const satisfies Record<string, ParameterBudget>;

/** The per-call budget that stopped a proxy inspection. */
export const evmProxyBudgetLimit = parameterBudgetLimitFor(EVM_PROXY_BUDGETS);

export const inspectEvmProxyInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute path to caller-selected local bytecode carrier",
  ),
  encoding: z
    .enum(["raw", "hex"])
    .describe(
      "Raw bytes or UTF-8 hex with optional 0x prefix and outer ASCII whitespace",
    ),
  max_file_bytes: parameterBudgetSchema(
    EVM_PROXY_BUDGETS.max_file_bytes,
  ).describe("Maximum stable carrier bytes to read (default 4 MiB)"),
});
export type InspectEvmProxyInput = z.output<typeof inspectEvmProxyInputSchema>;

const byteCount = z.int().nonnegative();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const proxyPatternSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("erc1167"),
    implementation: z.string().regex(/^0x[0-9a-f]{40}$/),
    implementation_byte_range: z.strictObject({
      start: byteCount,
      end: byteCount,
    }),
  }),
  z.strictObject({ kind: z.literal("none_recognized") }),
]);
export type EvmProxyPattern = z.output<typeof proxyPatternSchema>;

export const evmProxySchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256,
    bytes: byteCount,
    encoding: z.enum(["raw", "hex"]),
  }),
  bytecode: z.strictObject({ sha256, bytes: byteCount }),
  pattern: proxyPatternSchema,
  limitations: z.array(z.string()),
});
export type EvmProxy = z.output<typeof evmProxySchema>;

/** ERC-1167 runtime: fixed prefix, 20-byte target, fixed suffix. */
const ERC1167_PREFIX = Buffer.from("363d3d373d3d3d363d73", "hex");
const ERC1167_SUFFIX = Buffer.from("5af43d82803e903d91602b57fd5bf3", "hex");
const ADDRESS_BYTES = 20;

/** Match only the exact 45-byte standard clone; variants stay unrecognized. */
export const matchErc1167Clone = (code: Uint8Array): EvmProxyPattern => {
  const start = ERC1167_PREFIX.length;
  const end = start + ADDRESS_BYTES;
  const bytes = Buffer.from(code);
  if (
    bytes.length !== end + ERC1167_SUFFIX.length ||
    !bytes.subarray(0, start).equals(ERC1167_PREFIX) ||
    !bytes.subarray(end).equals(ERC1167_SUFFIX)
  )
    return { kind: "none_recognized" };
  return {
    kind: "erc1167",
    implementation: `0x${bytes.subarray(start, end).toString("hex")}`,
    implementation_byte_range: { start, end },
  };
};
