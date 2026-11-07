import type { AdbDeviceAnalysisPort } from "./AdbDeviceAnalysisPort.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import {
  adbRequestSchema,
  type AdbOperation,
} from "../../domain/adb/adbDeviceAnalysis.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import type { Result } from "../../domain/result.js";
import { executeProviderOperation } from "../ProviderOperationExecution.js";
import { adbEvidenceParameters } from "../../domain/adb/adbEvidenceParameters.js";
import { adbUiInputSchemas } from "../../domain/adb/adbUiAnalysis.js";

/** Shared CLI/MCP admission, execution, and Evidence composition for ADB. */
export class AdbDeviceAnalysisService {
  constructor(readonly provider: AdbDeviceAnalysisPort) {}

  /** Run one caller-selected ADB request and retain device provenance inline. */
  async execute(
    operation: AdbOperation,
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeProviderOperation(
      operation,
      input,
      options,
      adbRequestSchema,
      this.provider,
      "observed",
      {
        parameters: (request, execution) =>
          adbEvidenceParameters(request, execution.result),
        authority: (request) =>
          Object.hasOwn(adbUiInputSchemas, request.operation)
            ? "controlled-replay"
            : "shipped-artifact",
      },
    );
  }
}
