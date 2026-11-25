import type { z } from "zod";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { cancelledBy } from "../domain/analysisErrorCore.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../domain/result.js";
import { isRecord } from "../kernel/isRecord.js";

/** Keep top-level caller selections separate from defaults resolved for execution. */
export const callerAnalysisParameters = (rawInput: unknown) => {
  const selected = new Set(
    isRecord(rawInput)
      ? Object.keys(rawInput).filter((name) => rawInput[name] !== undefined)
      : [],
  );
  return <Input extends object>(resolved: Input): Partial<Input> => {
    const parameters = { ...resolved };
    for (const name of Object.keys(parameters))
      if (!selected.has(name)) Reflect.deleteProperty(parameters, name);
    return parameters;
  };
};

/** Validate an application request, honoring cancellation before admission when supplied. */
export const parseAnalysisInput = <T>(
  operation: string,
  rawInput: unknown,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Result<T, AnalysisError> => {
  if (signal?.aborted) return err(cancelledBy(operation, signal));
  const input = schema.safeParse(rawInput);
  if (!input.success)
    return err(
      analysisInputErrorFromIssues(operation, input.error.issues, rawInput, {
        cause: input.error,
      }),
    );
  return signal?.aborted ? err(cancelledBy(operation, signal)) : ok(input.data);
};
