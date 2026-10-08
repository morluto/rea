import { z } from "zod";

import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";

/** Project schema issues of the raw request onto their request paths. */
export const requestInputError = (
  operation: string,
  cause: z.ZodError,
  input: unknown,
): AnalysisInputError =>
  new AnalysisInputError(
    operation,
    { cause },
    projectInputIssues(cause.issues, input),
  );

/**
 * Keep the failed constraint when a parsed request is rejected later. Nested
 * values such as Evidence results are parsed on their own, so their issue
 * paths are relative to that value and are reported in the message, not as
 * request paths.
 */
export const workflowInputError = (
  operation: string,
  cause: z.ZodError | TypeError,
): AnalysisInputError =>
  new AnalysisInputError(
    operation,
    { cause },
    cause instanceof z.ZodError
      ? cause.issues.map((issue) => ({
          path: [],
          reason: "invalid_value" as const,
          message: `A nested value failed validation at ${issue.path.length === 0 ? "its root" : issue.path.map(String).join(".")}: ${issue.message}`,
        }))
      : [{ path: [], reason: "invalid_value", message: cause.message }],
  );
