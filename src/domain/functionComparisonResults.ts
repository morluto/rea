import { canonicalDigest } from "./comparisonSemantics.js";
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
): FunctionDimension => {
  const context = {
    dimension: input.dimension,
    left_digest: digest(input.left),
    right_digest: digest(input.right),
    left_count: input.leftCount,
    right_count: input.rightCount,
    text_delta: input.textDelta,
    evidence_links: [...input.links],
    limitations: [...input.limitations],
  };
  if (input.status === "unchanged")
    return {
      ...context,
      status: "unchanged",
      conclusion_kind: "derived_relationship",
    };
  return {
    ...context,
    status: "changed",
    conclusion_kind: input.providersDiffer
      ? "contradiction"
      : "derived_relationship",
  };
};

export const unresolvedDimension = (input: {
  readonly dimension: DimensionName;
  readonly links: readonly string[];
  readonly leftCount: number | null;
  readonly rightCount: number | null;
  readonly limitations: readonly string[];
}): FunctionDimension => ({
  dimension: input.dimension,
  status: "unknown",
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
  if (
    match === "ambiguous" ||
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
  unknown: dimensions.filter(({ status }) => status === "unknown").length,
});

const digest = (value: unknown): string =>
  canonicalDigest(value, "Function comparison");
