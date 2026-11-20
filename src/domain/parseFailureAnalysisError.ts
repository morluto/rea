import {
  type ANALYSIS_RESOURCE_KINDS,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
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
 * The public refusal for a parser's format failure on the selected artifact.
 *
 * Malformed and truncated bytes are an invalid `field` (the input that
 * selected the artifact, `path` by default); unsupported bytes are an
 * unsupported target. A `limit` and any other cause return `undefined`:
 * a limit's recovery names a budget only its producer knows. A producer that
 * retains a partial observation passes it as `diagnostics`.
 */
export const parseFailureAnalysisError = (
  operation: string,
  path: string,
  cause: unknown,
  field = "path",
  extra: Pick<AnalysisErrorOptions, "diagnostics"> = {},
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
        { cause, undecodedContent: failure.undecodedContent, ...extra },
      );
    case "malformed":
    case "truncated":
      return new AnalysisInputError(operation, { cause, ...extra }, [
        {
          path: [field],
          reason: "invalid_format",
          message: `Selected artifact ${path}: ${failure.detail}`,
        },
      ]);
  }
};
