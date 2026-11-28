import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { DebPackagePort } from "../../ports/deb/DebPackagePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectDebPackageInputSchema,
  debPackageSchema,
} from "../../domain/deb/debPackage.js";
import type { Result } from "../../domain/result.js";
import { callerAnalysisParameters } from "../AnalysisInput.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_deb_package";

/** Shared caller validation, output parsing and Evidence provenance for CLI and MCP. */
export class DebPackageService {
  constructor(readonly provider: DebPackagePort) {}

  close(): Promise<void> {
    return this.provider.close();
  }

  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectDebPackageInputSchema,
        outputSchema: debPackageSchema,
        provider: this.provider,
        invalidOutputMessage:
          "Debian package provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, input) =>
          report.artifact.path === input.path &&
          report.artifact.bytes <= input.max_file_bytes &&
          report.coverage.ar_members <= input.max_ar_members &&
          report.coverage.control_entries <= input.max_control_entries &&
          report.coverage.data_entries <= input.max_data_entries,
        buildEvidence: (value, identity, parameters) =>
          createEvidence(
            {
              path: value.artifact.path,
              format: "file",
              sha256: value.artifact.sha256,
            },
            identity,
            {
              operation: OPERATION,
              parameters: callerAnalysisParameters(rawInput)(parameters),
              result: value,
              confidence: "observed",
              limitations: value.limitations,
              locations: [
                { kind: "artifact-path", path: value.artifact.path },
                {
                  kind: "file-offset-range",
                  start: 0,
                  end: value.artifact.bytes,
                },
              ],
            },
          ),
      },
      rawInput,
      options,
    );
  }
}
