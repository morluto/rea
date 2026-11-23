import type { RequestAnalysisPort } from "../../ports/AnalysisProvider.js";
import type { FlutterRequest } from "../../domain/flutter/flutterBuildAnalysis.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import {
  flutterRequestSchema,
  type FlutterOperation,
} from "../../domain/flutter/flutterBuildAnalysis.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import { executeProviderOperation } from "../ProviderOperationExecution.js";
import type { Result } from "../../domain/result.js";

/** Shared CLI/MCP admission, execution, and Evidence composition for Flutter. */
export class FlutterBuildAnalysisService {
  constructor(readonly provider: RequestAnalysisPort<FlutterRequest>) {}

  /** Run one caller-selected Flutter request and retain target identity inline. */
  execute(
    operation: FlutterOperation,
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeProviderOperation(
      operation,
      input,
      options,
      flutterRequestSchema,
      this.provider,
      "observed",
    );
  }
}
