import { z } from "zod";

/** Defaults for one execution-free managed inspection, not PE format limits. */
export const DEFAULT_MANAGED_SNAPSHOT_BYTES = 128 * 1024 * 1024;
export const DEFAULT_MANAGED_REPRESENTATION_BYTES = 64 * 1024 * 1024;

export const managedInspectionBudgetShape = {
  max_snapshot_bytes: z
    .int()
    .positive()
    .optional()
    .describe(
      `Maximum eagerly retained PE snapshot bytes; omitted means ${String(DEFAULT_MANAGED_SNAPSHOT_BYTES)}. Raise for the next call to admit the same larger complete file; no restart. This does not raise metadata representation or host memory.`,
    ),
  max_metadata_representation_bytes: z
    .int()
    .positive()
    .optional()
    .describe(
      `Maximum accounted metadata, CIL and projected JSON bytes; omitted means ${String(DEFAULT_MANAGED_REPRESENTATION_BYTES)}. Raise for the next call after resource-limit coverage, or select fewer type_names for member inspection. No restart; snapshot, transport and host memory limits remain independent.`,
    ),
};
