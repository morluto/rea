import type { z } from "zod";
import {
  producerResourceLimitsSchema,
  resolveProducerLimits,
} from "../producerResourceLimits.js";

/** Budgets for the pure TypeScript UEFI firmware parser; every bound is explicit. */
export const UEFI_FIRMWARE_LIMITS = {
  /** Largest accepted firmware image; Gigabyte AMI images are 16 MiB. */
  inputBytes: 128 * 1024 * 1024,
  /** Prefix bytes inspected for signature-based format admission. */
  scanProbeBytes: 1024 * 1024,
  /** Maximum firmware volumes mapped before coverage turns partial. */
  maxVolumes: 1024,
  defaultMaxVolumes: 512,
  /** Maximum FFS files mapped before coverage turns partial. */
  maxFiles: 100_000,
  defaultMaxFiles: 20_000,
  /** Maximum nested section and sub-volume depth, clamped by caller input. */
  maxDepth: 5,
  defaultMaxDepth: 3,
  /** Maximum total bytes of staged extraction files. */
  maxOutputBytes: 256 * 1024 * 1024,
  defaultMaxOutputBytes: 256 * 1024 * 1024,
  maxOutputFiles: 10_000,
  defaultMaxOutputFiles: 10_000,
  /** Whole-operation deadline for parser and worker runs. */
  timeoutMs: 60_000,
  /** Per-stream decompressed output ceiling for both decoders. */
  lzmaOutputBytes: 64 * 1024 * 1024,
  /** Shared structural record ceiling per inspection or extraction. */
  scanRecords: 100_000,
  /** Limit retained and traversed decoded data across all streams in an operation. */
  decodedBytes: 128 * 1024 * 1024,
  /** Diagnostic text retained inline before truncation. */
  diagnosticBytes: 8 * 1024 * 1024,
} as const;

/** Defaults for UEFI decompile producer budgets. */
export const UEFI_DECOMPILE_PRODUCER_DEFAULTS = {
  input_bytes: 128 * 1024 * 1024,
  output_bytes: 4 * 1024 * 1024,
  file_bytes: 64 * 1024 * 1024,
} as const;

export const uefiProducerLimitsSchema = producerResourceLimitsSchema.pick({
  input_bytes: true,
  output_bytes: true,
  file_bytes: true,
});

export const uefiProducerLimitsField = uefiProducerLimitsSchema
  .optional()
  .describe(
    "Per-call producer limits in bytes: input_bytes (raw executable payload staging budget, default 128 MiB), output_bytes (per-module decompiled C and disassembly limit, default 4 MiB), and file_bytes (aggregate decompiled C and disassembly output budget, default 64 MiB). Positive safe integers; applies on the next call without restart.",
  );

export type UefiProducerLimitsInput = z.output<typeof uefiProducerLimitsSchema>;
export const resolveUefiProducerLimits = (selected?: UefiProducerLimitsInput) =>
  resolveProducerLimits(UEFI_DECOMPILE_PRODUCER_DEFAULTS, selected);
export type UefiProducerLimits = ReturnType<typeof resolveUefiProducerLimits>;
