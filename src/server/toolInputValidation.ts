import { z } from "zod";

import { AnalysisInputError } from "../domain/errors.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../domain/result.js";

/** Parse one MCP request and retain only schema-owned correction data. */
export const safeParseToolInput = <Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  operation: string,
): Result<z.output<Schema>, AnalysisInputError> => {
  const parsed = schema.safeParse(input);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new AnalysisInputError(
          operation,
          undefined,
          projectInputIssues(parsed.error.issues, input),
        ),
      );
};
