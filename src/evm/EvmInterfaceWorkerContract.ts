import { z } from "zod";
import { solidityMetadataSchema } from "../domain/evm/solidityMetadata.js";
import { inspectEvmInterfaceInputSchema } from "../domain/evm/evmInterface.js";
import {
  solcArtifactSchema,
  solcCompilerDiagnosticsSchema,
} from "../domain/evm/solcArtifact.js";
import { evmoleInterfaceReplySchema } from "./EvmoleInterfaceAdapter.js";
import { EVM_INTERFACE_LIMITS } from "./EvmoleRelease.js";

const workerRequestFields = {
  snapshot_path: z.string(),
  reply_path: z.string(),
  failure_marker_path: z.string(),
  file_size_bytes: z
    .number()
    .int()
    .nonnegative()
    .max(EVM_INTERFACE_LIMITS.outputBytes),
};
/** One transport owner binds the exact selected representation to its private snapshot. */
export const evmWorkerRequestSchema = inspectEvmInterfaceInputSchema
  .omit({ path: true })
  .extend(workerRequestFields);
export const evmWorkerReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    version: z.literal("0.9.3"),
    bytecode: z.strictObject({
      metadata: solidityMetadataSchema.nullable().optional(),
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
      bytes: z.number().int().nonnegative().nullable(),
      hex: z
        .string()
        .regex(/^(?:[a-f0-9]{2})*$/)
        .nullable(),
    }),
    raw: evmoleInterfaceReplySchema.nullable(),
    compiler_artifact: solcArtifactSchema.optional(),
    carrier_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum([
      "format",
      "selection",
      "resource",
      "decoder",
      "output-limit",
      "unsupported",
    ]),
    message: z.string(),
    compiler_diagnostics: solcCompilerDiagnosticsSchema.optional(),
    compiler_diagnostics_omitted: z.literal("reply-budget").optional(),
    carrier_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  }),
]);
