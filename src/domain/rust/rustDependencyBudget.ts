import { constants as bufferConstants } from "node:buffer";
import { z } from "zod";

import type { AnalysisParameterLimit } from "../analysisSettings.js";
import {
  parameterBudgetLimit,
  type ParameterBudget,
} from "../parameterBudget.js";

/**
 * Bytes of one compressed `.dep-v0` zlib stream. The section is one Buffer,
 * so the maximum is the largest Buffer the runtime can hold.
 */
export const RUST_COMPRESSED_DEPENDENCY_BUDGET = {
  minimum: 1,
  maximum: bufferConstants.MAX_LENGTH,
  default_value: 1024 * 1024,
  unit: "bytes",
} as const satisfies ParameterBudget;

/**
 * Absolute inflated dependency JSON. The decoded document is one string, so
 * the maximum is the largest string the runtime can hold.
 */
export const RUST_INFLATED_DEPENDENCY_BUDGET = {
  minimum: 1,
  maximum: bufferConstants.MAX_STRING_LENGTH,
  default_value: 8 * 1024 * 1024,
  unit: "bytes",
} as const satisfies ParameterBudget;

/**
 * Inflated length divided by the consumed compressed length. Allocation
 * before that length is known uses the stored extent, including PE alignment
 * padding, so a raise here also raises that earlier cap. The absolute
 * inflated budget still bounds the allocation.
 */
export const RUST_DEPENDENCY_INFLATE_RATIO_BUDGET = {
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
  default_value: 64,
  unit: "count",
} as const satisfies ParameterBudget;

/** Per-call dependency-parser budgets, keyed by the contract field that sets them. */
export const RUST_DEPENDENCY_BUDGETS = {
  max_compressed_dependency_bytes: RUST_COMPRESSED_DEPENDENCY_BUDGET,
  max_inflated_dependency_bytes: RUST_INFLATED_DEPENDENCY_BUDGET,
  max_dependency_inflate_ratio: RUST_DEPENDENCY_INFLATE_RATIO_BUDGET,
} as const;

export type RustDependencyBudgetName = keyof typeof RUST_DEPENDENCY_BUDGETS;

const budgetField = (name: RustDependencyBudgetName, description: string) => {
  const budget = RUST_DEPENDENCY_BUDGETS[name];
  return z
    .int()
    .min(budget.minimum)
    .max(budget.maximum)
    .exactOptional()
    .describe(
      `${description} Default ${String(budget.default_value)}, from ${String(budget.minimum)} to ${String(budget.maximum)}. Applies on the next call.`,
    );
};

/** Optional `inspect_rust_binary` fields for the dependency-parser ceilings. */
export const rustDependencyBudgetFields = {
  max_compressed_dependency_bytes: budgetField(
    "max_compressed_dependency_bytes",
    "Maximum bytes of the compressed .dep-v0 zlib stream.",
  ),
  max_inflated_dependency_bytes: budgetField(
    "max_inflated_dependency_bytes",
    "Maximum inflated dependency JSON bytes. The admitted length is also bounded by max_dependency_inflate_ratio times the consumed compressed stream.",
  ),
  max_dependency_inflate_ratio: budgetField(
    "max_dependency_inflate_ratio",
    "Maximum inflated-to-consumed-compressed length ratio for dependency JSON.",
  ),
};

/** The three ceilings one dependency parse enforces. */
export interface RustDependencyBudgets {
  readonly compressedBytes: number;
  readonly inflatedBytes: number;
  readonly inflateRatio: number;
}

/** Omitted fields keep the parser defaults. */
export const resolveRustDependencyBudgets = (
  input: {
    readonly max_compressed_dependency_bytes?: number | undefined;
    readonly max_inflated_dependency_bytes?: number | undefined;
    readonly max_dependency_inflate_ratio?: number | undefined;
  } = {},
): RustDependencyBudgets => ({
  compressedBytes:
    input.max_compressed_dependency_bytes ??
    RUST_COMPRESSED_DEPENDENCY_BUDGET.default_value,
  inflatedBytes:
    input.max_inflated_dependency_bytes ??
    RUST_INFLATED_DEPENDENCY_BUDGET.default_value,
  inflateRatio:
    input.max_dependency_inflate_ratio ??
    RUST_DEPENDENCY_INFLATE_RATIO_BUDGET.default_value,
});

/**
 * `min(absolute, bytes * ratio)` without multiplying past the absolute cap.
 * A stored extent can include alignment padding, so this is the allocation
 * bound before the consumed stream length is known.
 */
export const cappedInflateBytes = (
  bytes: number,
  ratio: number,
  absolute: number,
): number => {
  if (bytes <= 0 || ratio <= 0) return 0;
  if (ratio > Math.floor(absolute / bytes)) return absolute;
  return bytes * ratio;
};

/** The per-call control a dependency-parser refusal names, when `name` is one. */
export const rustDependencyParameterLimit = (
  name: string,
  effectiveValue: number,
  required: number | bigint | undefined,
): AnalysisParameterLimit | undefined => {
  if (!Object.hasOwn(RUST_DEPENDENCY_BUDGETS, name)) return undefined;
  const budget = RUST_DEPENDENCY_BUDGETS[name as RustDependencyBudgetName];
  return {
    ...parameterBudgetLimit(name, budget, effectiveValue),
    ...(typeof required === "number" ? { required_value: required } : {}),
  };
};
