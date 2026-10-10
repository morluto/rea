import { z } from "zod";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  AnalysisExecution,
  ExecutionOptions,
} from "./AnalysisProvider.js";

/** Validated caller-selected request carrying its operation input. */
export interface ProviderOperationRequest {
  readonly input: unknown;
}

/** Provider boundary executing one validated caller-selected request. */
export interface ProviderOperationPort<
  TRequest extends ProviderOperationRequest,
> {
  execute(
    request: TRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}

/**
 * Shared CLI/MCP admission, execution, and Evidence composition for
 * single-request providers. The caller retains its operation vocabulary and
 * confidence; this normalizes cancellation, input validation, and Evidence
 * assembly once instead of per provider.
 */
export const executeProviderOperation = async <
  TRequest extends ProviderOperationRequest,
>(
  operation: string,
  input: unknown,
  options: ExecutionOptions | undefined,
  schema: z.ZodType<TRequest>,
  provider: ProviderOperationPort<TRequest>,
  confidence: "observed" | "derived",
): Promise<Result<Evidence, AnalysisError>> => {
  if (options?.signal?.aborted === true)
    return err(new AnalysisCancelledError(operation));
  const request = schema.safeParse({ operation, input });
  if (!request.success)
    return err(new AnalysisInputError(operation, { cause: request.error }));
  const executed = await provider.execute(request.data, options);
  if (!executed.ok) return executed;
  const execution = executed.value;
  return ok(
    createEvidence(execution.subject ?? undefined, execution.provider, {
      operation,
      parameters: jsonObjectSchema.parse(request.data.input),
      result: execution.result,
      rawResult: execution.rawResult,
      limitations: execution.limitations,
      locations: execution.locations,
      confidence,
    }),
  );
};
