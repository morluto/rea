import { z } from "zod";
import { createHash } from "node:crypto";

import { absoluteLocalPathStringSchema } from "../localPath.js";
import { solidityMetadataSchema } from "./solidityMetadata.js";
import { inspectSolcBytecodeObject } from "./solcBytecodeObject.js";
import {
  compilerSelectionSchema,
  solcArtifactSchema,
  type CompilerSelection,
} from "./solcArtifact.js";

const byteOffset = z.int().nonnegative();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
/** Owned EVMole worker deadline. Omission keeps this value. */
export const DEFAULT_EVM_TIMEOUT_MS = 30_000;
/** Largest delay supported without overflowing Node timers. */
export const MAX_EVM_TIMEOUT_MS = 2_147_483_647;

/** Keep each selected compiler encoding self-contained in advertised JSON Schemas. */
export const evmEncodingSchema = z.union([
  z.enum(["raw", "hex"]),
  compilerSelectionSchema.extend({ kind: z.literal("solc-json") }),
]);
export type EvmEncoding = z.infer<typeof evmEncodingSchema>;
export const evmEncodingKind = (
  encoding: EvmEncoding,
): "raw" | "hex" | "solc-json" =>
  typeof encoding === "string" ? encoding : encoding.kind;
/** One owner projects exact compiler identity from the selected representation. */
export const evmCompilerSelection = (
  encoding: EvmEncoding,
): CompilerSelection | undefined => {
  if (typeof encoding === "string") return undefined;
  const { kind: _kind, ...selection } = encoding;
  return selection;
};
/** Explicit local carrier; compiler identities are opaque keys rather than paths. */
export const inspectEvmInterfaceInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute caller-selected bytecode or solc Standard JSON carrier",
  ),
  encoding: evmEncodingSchema.describe(
    "raw/hex, or {kind: solc-json, source_unit, contract_name, bytecode_kind: creation|deployed} for exact compiler selection",
  ),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(MAX_EVM_TIMEOUT_MS)
    .optional()
    .describe(
      `Deadline in milliseconds for the owned EVMole worker command (default ${String(DEFAULT_EVM_TIMEOUT_MS)}), not carrier acquisition or final reply reads. An integer from 1 to ${String(MAX_EVM_TIMEOUT_MS)} applies on the next call. Fixed input, reply, diagnostic, address-space, and CPU allowances stay unchanged.`,
    ),
});

/** Recovered interface candidates are inferences, independently of observed byte identity. */
export const evmInterfaceSchema = z
  .strictObject({
    artifact: z.strictObject({
      path: z.string().min(1),
      sha256,
      bytes: byteOffset,
      encoding: z.enum(["raw", "hex", "solc-json"]),
    }),
    bytecode: z.strictObject({
      sha256: sha256.nullable(),
      bytes: byteOffset.nullable(),
      hex: z
        .string()
        .regex(/^(?:[0-9a-f]{2})*$/)
        .nullable(),
      digest_algorithm: z.literal("sha256"),
      kind: z.enum(["unknown", "creation", "deployed"]),
      deployment_authenticity: z.literal("unknown"),
      hardfork: z.literal("unknown"),
      metadata: solidityMetadataSchema.nullable().default(null),
    }),
    compiler_artifact: solcArtifactSchema.optional(),
    inference_status: z.enum(["examined", "unavailable"]).optional(),
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
    if (
      value.bytecode.hex !== null &&
      (value.bytecode.bytes === null ||
        value.bytecode.hex.length !== value.bytecode.bytes * 2)
    )
      context.addIssue({
        code: "custom",
        path: ["bytecode"],
        message:
          "Selected byte count does not match the bytecode hex representation.",
      });
    const metadata = value.bytecode.metadata;
    if (
      metadata !== null &&
      metadata.status !== "unavailable" &&
      (value.bytecode.hex === null ||
        value.bytecode.bytes === null ||
        metadata.bytecode_offset === null ||
        metadata.cbor_bytes === null ||
        metadata.bytecode_offset + metadata.cbor_bytes + 2 !==
          value.bytecode.bytes ||
        metadata.cbor_bytes !==
          Number.parseInt(value.bytecode.hex.slice(-4), 16))
    )
      context.addIssue({
        code: "custom",
        path: ["bytecode", "metadata"],
        message:
          "Metadata range must match the terminal length suffix in selected bytecode.",
      });
    const compiler = value.compiler_artifact;
    const compilerObject =
      compiler?.object == null
        ? null
        : inspectSolcBytecodeObject(compiler.object);
    const concrete =
      value.bytecode.hex !== null &&
      value.bytecode.sha256 !== null &&
      value.bytecode.bytes !== null;
    if (value.artifact.encoding === "solc-json") {
      if (
        compiler === undefined ||
        value.inference_status === undefined ||
        compiler.selection.bytecode_kind !== value.bytecode.kind ||
        (compiler.status === "concrete") !== concrete ||
        (compiler.status === "concrete" ? "examined" : "unavailable") !==
          value.inference_status ||
        (compilerObject === null
          ? null
          : compilerObject.ok
            ? compilerObject.value.byteLength
            : undefined) !== value.bytecode.bytes ||
        (compiler.status === "concrete" &&
          (compiler.object?.toLowerCase() !== value.bytecode.hex ||
            createHash("sha256")
              .update(Buffer.from(value.bytecode.hex ?? "", "hex"))
              .digest("hex") !== value.bytecode.sha256)) ||
        (compiler.status !== "concrete" &&
          (value.bytecode.hex !== null ||
            value.bytecode.sha256 !== null ||
            value.bytecode.metadata !== null ||
            value.functions.length !== 0))
      )
        context.addIssue({
          code: "custom",
          path: ["compiler_artifact"],
          message:
            "Compiler selection, byte identity and inference availability are inconsistent.",
        });
    } else if (
      compiler !== undefined ||
      !concrete ||
      value.bytecode.kind !== "unknown" ||
      value.inference_status !== undefined
    )
      context.addIssue({
        code: "custom",
        path: ["bytecode"],
        message:
          "Raw/hex Evidence requires concrete bytes and unknown compiler kind without compiler selection.",
      });
    for (const [index, fn] of value.functions.entries())
      if (
        value.bytecode.bytes === null ||
        fn.bytecode_offset >= value.bytecode.bytes
      )
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

/** Bind parsed report facts to the exact caller-selected carrier and compiler object. */
export const matchesEvmInterfaceInput = (
  report: EvmInterface,
  input: InspectEvmInterfaceInput,
): boolean => {
  const selection = evmCompilerSelection(input.encoding);
  return (
    report.artifact.path === input.path &&
    report.artifact.encoding === evmEncodingKind(input.encoding) &&
    (selection === undefined ||
      (report.compiler_artifact?.selection.source_unit ===
        selection.source_unit &&
        report.compiler_artifact.selection.contract_name ===
          selection.contract_name &&
        report.compiler_artifact.selection.bytecode_kind ===
          selection.bytecode_kind))
  );
};
