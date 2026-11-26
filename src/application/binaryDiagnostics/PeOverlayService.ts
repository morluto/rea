import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { PeOverlayPort } from "../../ports/binaryDiagnostics/PeOverlayPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectPeOverlayInputSchema,
  peOverlaySchema,
} from "../../domain/native/peOverlay.js";
import { peSubjectArchitecture } from "../../domain/peMachine.js";
import type { Result } from "../../domain/result.js";
import { callerAnalysisParameters } from "../AnalysisInput.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_pe_overlay";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class PeOverlayService {
  constructor(readonly provider: PeOverlayPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const selectedParameters = callerAnalysisParameters(rawInput);
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectPeOverlayInputSchema,
        outputSchema: peOverlaySchema,
        provider: this.provider,
        invalidOutputMessage:
          "PE overlay provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          report.artifact.bytes <= parameters.max_file_bytes,
        buildEvidence: (value, identity, parameters) => {
          const architecture = peSubjectArchitecture(
            value.machine,
            value.format,
          );
          const locations = [
            { kind: "artifact-path" as const, path: value.artifact.path },
            ...value.ranges.map((range) => ({
              kind: "file-offset-range" as const,
              start: range.offset,
              end: range.offset + range.size,
            })),
          ];
          return createEvidence(
            {
              path: value.artifact.path,
              format: "pe",
              sha256: value.artifact.sha256,
              ...(architecture === undefined ? {} : { architecture }),
            },
            identity,
            {
              operation: OPERATION,
              parameters: selectedParameters(parameters),
              result: value,
              confidence: "derived",
              limitations: value.limitations,
              locations,
            },
          );
        },
      },
      rawInput,
      options,
    );
  }
}
