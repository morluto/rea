import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  solidityMetadataVerificationSchema,
  verifySolidityMetadataInputSchema,
} from "../../domain/evm/solidityMetadataBinding.js";
import type { Result } from "../../domain/result.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { SolidityMetadataBindingPort } from "../../ports/evm/SolidityMetadataBindingPort.js";
import { callerAnalysisParameters } from "../AnalysisInput.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "verify_solidity_metadata";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class SolidityMetadataBindingService {
  constructor(readonly provider: SolidityMetadataBindingPort) {}

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
        inputSchema: verifySolidityMetadataInputSchema,
        outputSchema: solidityMetadataVerificationSchema,
        provider: this.provider,
        invalidOutputMessage:
          "Metadata verification returned malformed output or changed file identity.",
        toParameters: (input) => input,
        validateReport: (report, input) =>
          report.artifact.path === input.path &&
          report.artifact.encoding === input.encoding &&
          report.artifact.bytes <= input.max_file_bytes &&
          report.metadata_file.path === input.metadata_path &&
          report.metadata_file.bytes <= input.max_metadata_bytes,
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
              parameters: callerAnalysisParameters(rawInput)(parameters),
              result: report,
              confidence: "derived",
              limitations: report.limitations,
              locations: [
                { kind: "artifact-path", path: report.artifact.path },
                { kind: "artifact-path", path: report.metadata_file.path },
              ],
            },
          ),
      },
      rawInput,
      options,
    );
  }
}
