import type {
  ExecutionOptions,
  RequestAnalysisPort,
} from "../../ports/AnalysisProvider.js";
import {
  pcapRequestSchema,
  type PcapOperation,
  type PcapRequest,
} from "../../domain/pcap/pcapAnalysis.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import { createPcapEvidence } from "../../domain/pcap/pcapEvidence.js";
import type { Result } from "../../domain/result.js";
import { executeProviderOperation } from "../ProviderOperationExecution.js";

/** Shared CLI/MCP admission, execution, and Evidence composition for pcap. */
export class PcapAnalysisService {
  constructor(readonly provider: RequestAnalysisPort<PcapRequest>) {}

  /** Run one caller-selected pcap request and retain capture identity inline. */
  execute(
    operation: PcapOperation,
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeProviderOperation(
      operation,
      input,
      options,
      pcapRequestSchema,
      this.provider,
      "observed",
      createPcapEvidence,
    );
  }
}
