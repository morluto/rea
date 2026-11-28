import {
  type ANALYSIS_RESOURCE_KINDS,
  AnalysisTargetFailureError,
  AnalysisResourceConstraintError,
  type ResourceConstraintRecovery,
} from "./analysisErrorCore.js";
import type { AnalysisErrorOptions } from "./analysisErrorBase.js";
import type { JsonValue } from "./jsonValue.js";
import { ParseFailureError, reportedParseLimit } from "./parseFailure.js";

/** A parse limit of `format`; any other cause, or another format's limit, is not one. */
export const isParseLimit = (
  cause: unknown,
  format: string,
): cause is ParseFailureError<"limit"> =>
  cause instanceof ParseFailureError &&
  cause.failure.kind === "limit" &&
  cause.failure.format === format;

/**
 * The public refusal for a parse that stopped at a named limit. The reason is
 * the failure's detail (prefixed with `Selected artifact <path>:` when `path`
 * names one) and `reportedLimits` comes from the failure's `LimitRef`
 * (`{ boundary: name, maximum, required? }`), so neither is spelled again at
 * the catch site. Existing contracts may keep context fields and select their
 * established field for the maximum. The producer supplies budget recovery.
 */
export const parseLimitConstraint = (
  operation: string,
  resource: (typeof ANALYSIS_RESOURCE_KINDS)[number],
  cause: ParseFailureError<"limit">,
  options: Omit<AnalysisErrorOptions, "cause"> &
    ResourceConstraintRecovery & {
      readonly path?: string | undefined;
      readonly legacyMaximumKey?: string;
      readonly reportedLimitContext?: Readonly<Record<string, JsonValue>>;
      readonly requestSent?: boolean;
    },
): AnalysisResourceConstraintError => {
  const { detail, limit } = cause.failure;
  const { path, legacyMaximumKey, reportedLimitContext, ...errorOptions } =
    options;
  const reportedLimit =
    legacyMaximumKey === undefined
      ? reportedParseLimit(limit)
      : { [legacyMaximumKey]: limit.maximum };
  return new AnalysisResourceConstraintError(
    operation,
    resource,
    path === undefined ? detail : `Selected artifact ${path}: ${detail}`,
    { ...reportedLimitContext, ...reportedLimit },
    { ...errorOptions, cause },
  );
};

/**
 * The public refusal for a tools/list page that one advertised tool exceeds.
 * Unlike parseLimitConstraint, the cause is a page budget, not a parse limit:
 * the reason and the reported limit come from the page-budget facts the
 * producer supplies, and the producer still supplies the recovery, which
 * names a budget only it knows. The budget facts are structural on purpose:
 * domain may not import the config layer that owns the budget type.
 */
export const toolsListPageBudgetConstraint = (
  budget: {
    readonly setting: string;
    readonly bytes: number;
    readonly source: string;
    readonly defaultBytes: number;
    readonly floorBytes: number;
    readonly maximumBytes: number;
  },
  toolName: string,
  options: Omit<AnalysisErrorOptions, "cause"> &
    ResourceConstraintRecovery & { readonly requestSent?: boolean },
): AnalysisResourceConstraintError => {
  return new AnalysisResourceConstraintError(
    "tools/list",
    "transport",
    `Advertised tool ${toolName} is larger than the tools/list page budget.`,
    {
      setting: budget.setting,
      effective_bytes: budget.bytes,
      source: budget.source,
      default_bytes: budget.defaultBytes,
      floor_bytes: budget.floorBytes,
      maximum_bytes: budget.maximumBytes,
      tool_name: toolName,
    },
    options,
  );
};

/**
 * The public refusal for a parser's format failure on the selected artifact.
 *
 * The parser reads the target's bytes, not the request, so every format
 * failure is a target refusal: malformed and truncated bytes are a malformed
 * target, unsupported bytes an unsupported target, and bytes that are not the
 * owner's format at all an unrecognized target. A `limit` and any
 * other cause return `undefined`: a limit's recovery names a budget only its
 * producer knows.
 */
export const parseFailureAnalysisError = (
  operation: string,
  path: string,
  cause: unknown,
  options?: Omit<AnalysisErrorOptions, "cause">,
): AnalysisTargetFailureError | undefined => {
  if (!(cause instanceof ParseFailureError)) return undefined;
  const { failure } = cause;
  switch (failure.kind) {
    case "limit":
      return undefined;
    case "unrecognized":
    case "unsupported":
    case "malformed":
    case "truncated":
      return new AnalysisTargetFailureError(operation, path, failure, {
        ...options,
        cause,
      });
  }
};
