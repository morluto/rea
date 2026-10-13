import type { PcapAnalysisPort } from "./PcapAnalysisPort.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import {
  pcapRequestSchema,
  type PcapOperation,
} from "../../domain/pcap/pcapAnalysis.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import { createPcapEvidence } from "../../domain/pcap/pcapEvidence.js";
import { err, ok, type Result } from "../../domain/result.js";

/** Shared CLI/MCP admission, execution, and Evidence composition for pcap. */
export class PcapAnalysisService {
  constructor(readonly provider: PcapAnalysisPort) {}

  /** Run one caller-selected pcap request and retain capture identity inline. */
  async execute(
    operation: PcapOperation,
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted === true)
      return err(new AnalysisCancelledError(operation));
    const request = pcapRequestSchema.safeParse({ operation, input });
    if (!request.success)
      return err(new AnalysisInputError(operation, { cause: request.error }));
    const executed = await this.provider.execute(request.data, options);
    if (!executed.ok) return executed;
    const execution = executed.value;
    return ok(createPcapEvidence(request.data, execution));
  }
}
