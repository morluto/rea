import { z } from "zod";

import type { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import type { AnalysisParameterLimit } from "../analysisSettings.js";
import {
  DEFAULT_NATIVE_STRUCTURE_BYTES,
  NATIVE_STRUCTURE_LIMIT,
  type BinaryResourceFailure,
} from "../binaryContainer.js";
import { parseLimitConstraint } from "../parseFailureAnalysisError.js";

/**
 * `max_structure_bytes`: the bytes of one native table read (ELF program and
 * section header tables, the ELF section-name table, the PE headers and
 * section table, Mach-O load commands, the ELF dynamic directory) and,
 * separately, of the section names decoded from it. Decoded records are
 * proportional to the table bytes, so the budget bounds that representation
 * before it is allocated.
 */
export const NATIVE_STRUCTURE_BYTES = {
  /** An ELF64 file header. */
  minimum: 64,
  maximum: 512 * 1024 * 1024,
  default_value: DEFAULT_NATIVE_STRUCTURE_BYTES,
} as const;

/** The optional per-call field every native reader that decodes these tables accepts. */
export const maxStructureBytesSchema = z
  .number()
  .int()
  .min(NATIVE_STRUCTURE_BYTES.minimum)
  .max(NATIVE_STRUCTURE_BYTES.maximum)
  .optional()
  .describe(
    "Maximum bytes of one native header, section or load-command table this reader decodes, and of the section names decoded from it (default 16 MiB)",
  );

/** Caller-selected native directory budgets; omitted fields keep their defaults. */
export interface NativeDirectoryBudgets {
  /** `max_structure_bytes`. */
  readonly structureBytes?: number | undefined;
  /**
   * Source file bytes plus decoded section names, when the caller selected a
   * combined `max_file_bytes` read budget for them.
   */
  readonly sourceAndDecodedNamesBytes?: number | undefined;
}

/**
 * The per-call control that stopped a native table read, named by its
 * contract field; each adapter names the option that sets it.
 */
export const nativeStructureLimit = (
  effectiveValue: number,
): AnalysisParameterLimit => ({
  control_kind: "parameter",
  parameter: NATIVE_STRUCTURE_LIMIT,
  effective_value: effectiveValue,
  unit: "bytes",
  ...NATIVE_STRUCTURE_BYTES,
  applies_at: "next_call",
});

/**
 * The refusal of a native table read above `max_structure_bytes`. The
 * failure carries the value its reader enforced, so the limit reports what
 * stopped this call. The table that stopped the read is not necessarily the
 * largest one a retry must pass, so no `required_value` is reported.
 */
export const nativeStructureConstraint = (
  operation: string,
  failure: BinaryResourceFailure,
  path?: string,
): AnalysisResourceConstraintError =>
  parseLimitConstraint(operation, "memory", failure, {
    ...(path === undefined ? {} : { path }),
    retryable: false,
    limit: nativeStructureLimit(failure.maximum_bytes),
  });
