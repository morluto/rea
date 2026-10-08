import { z } from "zod";

import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { projectInputIssues } from "../../domain/inputIssueProjection.js";

/**
 * Keep the failed caller constraint when a managed workflow rejects input:
 * schema issues keep their paths, and domain checks keep their message.
 */
export const managedInputError = (
  operation: string,
  cause: z.ZodError | TypeError,
  input: unknown,
): AnalysisInputError =>
  new AnalysisInputError(
    operation,
    { cause },
    cause instanceof z.ZodError
      ? projectInputIssues(cause.issues, input)
      : [{ path: [], reason: "invalid_value", message: cause.message }],
  );
