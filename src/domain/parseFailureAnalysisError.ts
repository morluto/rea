import {
  type ANALYSIS_RESOURCE_KINDS,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
  type ResourceConstraintRecovery,
} from "./analysisErrorCore.js";
import type { AnalysisErrorOptions } from "./analysisErrorBase.js";
import { ParseFailureError } from "./parseFailure.js";

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
 * the failure's detail and the reported limit is the failure's `LimitRef`
 * (`{ [name]: maximum }`), so neither is spelled again at the catch site. The
 * producer still supplies the recovery, which names a budget only it knows.
 */
export const parseLimitConstraint = (
  operation: string,
  resource: (typeof ANALYSIS_RESOURCE_KINDS)[number],
  cause: ParseFailureError<"limit">,
  options: Omit<AnalysisErrorOptions, "cause"> &
    ResourceConstraintRecovery & { readonly requestSent?: boolean },
): AnalysisResourceConstraintError => {
  const { detail, limit } = cause.failure;
  return new AnalysisResourceConstraintError(
    operation,
    resource,
    detail,
    { [limit.name]: limit.maximum },
    { ...options, cause },
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
 * Malformed and truncated bytes are an invalid `field` (the input that
 * selected the artifact, `path` by default); unsupported bytes are an
 * unsupported target. A `limit` and any other cause return `undefined`:
 * a limit's recovery names a budget only its producer knows.
 */
export const parseFailureAnalysisError = (
  operation: string,
  path: string,
  cause: unknown,
  field = "path",
): AnalysisInputError | AnalysisUnsupportedTargetError | undefined => {
  if (!(cause instanceof ParseFailureError)) return undefined;
  const { failure } = cause;
  switch (failure.kind) {
    case "limit":
      return undefined;
    case "unsupported":
      return new AnalysisUnsupportedTargetError(
        operation,
        path,
        failure.detail,
        { cause, undecodedContent: failure.undecodedContent },
      );
    case "malformed":
    case "truncated":
      return new AnalysisInputError(operation, { cause }, [
        {
          path: [field],
          reason: "invalid_format",
          message: `Selected artifact ${path}: ${failure.detail}`,
        },
      ]);
  }
};
