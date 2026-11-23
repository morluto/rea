import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { MavenGradleMetadataPort } from "../../ports/java/MavenGradleMetadataPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectMavenGradleMetadataInputSchema,
  mavenGradleMetadataSchema,
  type MavenGradleMetadata,
} from "../../domain/java/mavenGradleMetadata.js";
import type { Result } from "../../domain/result.js";
import { callerAnalysisParameters } from "../AnalysisInput.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_maven_gradle_metadata";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class MavenGradleMetadataService {
  constructor(readonly provider: MavenGradleMetadataPort) {}

  close(): Promise<void> {
    return this.provider.close();
  }

  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const selectedParameters = callerAnalysisParameters(rawInput);
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectMavenGradleMetadataInputSchema,
        outputSchema: mavenGradleMetadataSchema,
        provider: this.provider,
        invalidOutputMessage:
          "Maven/Gradle metadata provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          validReport(report, parameters),
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
              parameters: selectedParameters(parameters),
              result: value,
              confidence: "observed",
              limitations: value.limitations,
              locations: [
                { kind: "artifact-path" as const, path: value.artifact.path },
                {
                  kind: "file-offset-range" as const,
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

const validReport = (
  report: MavenGradleMetadata,
  input: { max_file_bytes: number },
): boolean => {
  if (report.artifact.bytes > input.max_file_bytes) return false;
  if (report.coverage.examined_bytes !== report.artifact.bytes) return false;
  return true;
};
