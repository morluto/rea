import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  evmProxySchema,
  inspectEvmProxyInputSchema,
} from "../../domain/evm/evmProxy.js";
import type { Result } from "../../domain/result.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { EvmProxyPort } from "../../ports/evm/EvmProxyPort.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_evm_proxy";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class EvmProxyService {
  constructor(readonly provider: EvmProxyPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectEvmProxyInputSchema,
        outputSchema: evmProxySchema,
        provider: this.provider,
        invalidOutputMessage:
          "EVM proxy provider returned malformed output or changed carrier identity.",
        toParameters: (input) => input,
        validateReport: (report, input) =>
          report.artifact.path === input.path &&
          report.artifact.encoding === input.encoding &&
          report.artifact.bytes <= input.max_file_bytes &&
          report.related.length === (input.related?.length ?? 0) &&
          report.related.every(
            ({ artifact }, index) =>
              artifact.path === input.related?.[index]?.path &&
              artifact.bytes <= input.max_file_bytes,
          ),
        buildEvidence: (report, identity, parameters) =>
          createEvidence(
            {
              path: report.artifact.path,
              format: "file",
              sha256: report.artifact.sha256,
            },
            identity,
            {
              operation: OPERATION,
              parameters,
              result: report,
              confidence: "derived",
              limitations: report.limitations,
              locations: [
                { kind: "artifact-path", path: report.artifact.path },
              ],
            },
          ),
      },
      rawInput,
      options,
    );
  }
}
