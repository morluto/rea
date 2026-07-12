import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import type {
  DimensionName,
  FunctionComparisonResult,
  FunctionDimension,
} from "./functionComparisonSchemas.js";

export interface DimensionResultInput {
  readonly dimension: DimensionName;
  readonly status: "unchanged" | "changed";
  readonly left: unknown;
  readonly right: unknown;
  readonly links: readonly string[];
  readonly providersDiffer: boolean;
  readonly leftCount: number | null;
  readonly rightCount: number | null;
  readonly textDelta: FunctionDimension["text_delta"];
  readonly limitations: readonly string[];
}

export const dimensionResult = (
  input: DimensionResultInput,
): FunctionDimension => ({
  dimension: input.dimension,
  status: input.status,
  left_digest: digest(input.left),
  right_digest: digest(input.right),
  left_count: input.leftCount,
  right_count: input.rightCount,
  text_delta: input.textDelta,
  conclusion_kind:
    input.status === "changed" && input.providersDiffer
      ? "contradiction"
      : "derived_relationship",
  evidence_links: [...input.links],
  limitations: [...input.limitations],
});

export const unresolvedDimension = (input: {
  readonly dimension: DimensionName;
  readonly status: "truncated" | "unknown";
  readonly links: readonly string[];
  readonly leftCount: number | null;
  readonly rightCount: number | null;
  readonly limitations: readonly string[];
}): FunctionDimension => ({
  dimension: input.dimension,
  status: input.status,
  left_digest: null,
  right_digest: null,
  left_count: input.leftCount,
  right_count: input.rightCount,
  text_delta: null,
  conclusion_kind: "unresolved_branch",
  evidence_links: [...input.links],
  limitations: [...input.limitations],
});

export const overallStatus = (
  dimensions: readonly FunctionDimension[],
  match: FunctionComparisonResult["function_match"]["status"],
): FunctionComparisonResult["status"] => {
  if (dimensions.some(({ status }) => status === "truncated"))
    return "truncated";
  if (
    match === "ambiguous" ||
    match === "unknown" ||
    dimensions.some(({ status }) => status === "unknown")
  )
    return "unknown";
  if (match === "mismatched") return "changed";
  return dimensions.some(({ status }) => status === "changed")
    ? "changed"
    : "unchanged";
};

export const summarize = (dimensions: readonly FunctionDimension[]) => ({
  unchanged: dimensions.filter(({ status }) => status === "unchanged").length,
  changed: dimensions.filter(({ status }) => status === "changed").length,
  truncated: dimensions.filter(({ status }) => status === "truncated").length,
  unknown: dimensions.filter(({ status }) => status === "unknown").length,
});

export const canonicalJson = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Function comparison could not canonicalize data");
  return encoded;
};

const digest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
