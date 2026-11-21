import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { UefiAnalysisPort } from "../../ports/uefi/UefiAnalysisPort.js";
import {
  uefiRequestSchema,
  type UefiOperation,
} from "../../domain/uefi/uefiFirmwareAnalysis.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import { executeProviderOperation } from "../ProviderOperationExecution.js";
import type { Result } from "../../domain/result.js";

/** Shared CLI/MCP admission, execution, and Evidence composition for UEFI. */
export class UefiAnalysisService {
  constructor(readonly provider: UefiAnalysisPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  /** Run one caller-selected UEFI request and retain image identity inline. */
  execute(
    operation: UefiOperation,
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeProviderOperation(
      operation,
      input,
      options,
      uefiRequestSchema,
      this.provider,
      operation === "decompile_uefi_firmware" ? "derived" : "observed",
    );
  }
}
