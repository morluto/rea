import type { ApktoolResourceAnalysisPort } from "./ApktoolResourceAnalysisPort.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import {
  apktoolRequestSchema,
  type ApktoolOperation,
} from "../../domain/apktool/apktoolResourceAnalysis.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { jsonObjectSchema } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";

/** Shared CLI/MCP admission, execution, and Evidence composition for Apktool. */
export class ApktoolResourceAnalysisService {
  constructor(readonly provider: ApktoolResourceAnalysisPort) {}

  /** Run one caller-selected Apktool request and retain target identity inline. */
  async execute(
    operation: ApktoolOperation,
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted === true)
      return err(new AnalysisCancelledError(operation));
    const request = apktoolRequestSchema.safeParse({ operation, input });
    if (!request.success)
      return err(new AnalysisInputError(operation, { cause: request.error }));
    const executed = await this.provider.execute(request.data, options);
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
        confidence: "observed",
      }),
    );
  }
}
