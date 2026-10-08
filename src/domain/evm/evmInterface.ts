import { z } from "zod";

const byteOffset = z.number().int().nonnegative();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** Select the carrier representation explicitly; no RPC or deployed-contract lookup is implied. */
export const inspectEvmInterfaceInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe("Absolute path to caller-selected local bytecode carrier"),
  encoding: z
    .enum(["raw", "hex"])
    .describe(
      "Raw bytes or UTF-8 hex with optional 0x prefix and outer ASCII whitespace",
    ),
});

/** Recovered interface candidates are inferences, independently of observed byte identity. */
export const evmInterfaceSchema = z
  .strictObject({
    artifact: z.strictObject({
      path: z.string().min(1),
      sha256,
      bytes: byteOffset,
      encoding: z.enum(["raw", "hex"]),
    }),
    bytecode: z.strictObject({
      sha256,
      bytes: byteOffset,
      hex: z.string().regex(/^(?:[0-9a-f]{2})*$/),
      digest_algorithm: z.literal("sha256"),
      kind: z.literal("unknown"),
      deployment_authenticity: z.literal("unknown"),
      hardfork: z.literal("unknown"),
    }),
    evidence_kind: z.literal("inferred"),
    functions: z.array(
      z.strictObject({
        selector: z.string().regex(/^0x[0-9a-f]{8}$/),
        bytecode_offset: byteOffset,
        dispatch: z.enum(["abi", "fallback"]),
        inferred_arguments: z.string().nullable(),
        inferred_state_mutability: z.string().nullable(),
      }),
    ),
    discovery_completeness: z.literal("unknown"),
    runtime_execution: z.literal("not-performed"),
    diagnostics: z.strictObject({
      stdout: z.string(),
      stderr: z.string(),
      truncated: z.boolean(),
    }),
    limitations: z.array(z.string()),
  })
  .superRefine((value, context) => {
    if (value.bytecode.hex.length !== value.bytecode.bytes * 2)
      context.addIssue({
        code: "custom",
        path: ["bytecode"],
        message:
          "Selected byte count does not match the bytecode hex representation.",
      });
    for (const [index, fn] of value.functions.entries())
      if (fn.bytecode_offset >= value.bytecode.bytes)
        context.addIssue({
          code: "custom",
          path: ["functions", index, "bytecode_offset"],
          message: "Inferred body offset lies outside the selected bytecode.",
        });
  });

export type InspectEvmInterfaceInput = z.infer<
  typeof inspectEvmInterfaceInputSchema
>;
export type EvmInterface = z.infer<typeof evmInterfaceSchema>;
