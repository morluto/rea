import {
  AnalysisInputError,
  AnalysisUnsupportedTargetError,
} from "./analysisErrorCore.js";
import { ParseFailureError } from "./parseFailure.js";

/**
 * The public refusal for a parser's format failure on the selected artifact.
 *
 * Malformed and truncated bytes are an invalid `path`; unsupported bytes are
 * an unsupported target. A `limit` and any other cause return `undefined`:
 * a limit's recovery names a budget only its producer knows.
 */
export const parseFailureAnalysisError = (
  operation: string,
  path: string,
  cause: unknown,
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
          path: ["path"],
          reason: "invalid_format",
          message: `Selected artifact ${path}: ${failure.detail}`,
        },
      ]);
  }
};
