import type { AnalysisErrorOptions } from "./analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisUnsupportedTargetError,
} from "./analysisErrorCore.js";
import { ParseFailureError } from "./parseFailure.js";

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
