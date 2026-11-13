import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { MavenGradleMetadataPort } from "./MavenGradleMetadataPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectMavenGradleMetadataInputSchema,
  mavenGradleMetadataSchema,
  type MavenGradleMetadata,
} from "../../domain/java/mavenGradleMetadata.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

const OPERATION = "inspect_maven_gradle_metadata";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class MavenGradleMetadataService {
  constructor(readonly provider: MavenGradleMetadataPort) {}

  close(): Promise<void> {
    return this.provider.close();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const input = parseAnalysisInput(
      OPERATION,
      rawInput,
      inspectMavenGradleMetadataInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const result = await this.provider.inspect(input.value, options);
    if (!result.ok) return result;
    const report = mavenGradleMetadataSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      !validReport(report.data, input.value)
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Maven/Gradle metadata provider returned malformed output or changed artifact identity.",
        ),
      );
    const value = report.data;
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          format: "file",
          sha256: value.artifact.sha256,
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: input.value,
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
      options?.signal,
    );
  }
}

const validReport = (
  report: MavenGradleMetadata,
  input: { max_file_bytes: number },
): boolean => {
  if (report.artifact.bytes > input.max_file_bytes) return false;
  if (report.coverage.examined_bytes !== report.artifact.bytes) return false;
  if (report.format === "maven-pom" && report.gradle !== null) return false;
  if (report.format === "gradle-module" && report.parent !== null) return false;
  return true;
};
