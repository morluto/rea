import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { NugetNupkgPort } from "../../ports/nuget/NugetNupkgPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectNugetNupkgInputSchema,
  nugetNupkgSchema,
  type NugetNupkg,
} from "../../domain/nuget/nupkg.js";
import type { Result } from "../../domain/result.js";
import { callerAnalysisParameters } from "../AnalysisInput.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_nuget_nupkg";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class NugetNupkgService {
  constructor(readonly provider: NugetNupkgPort) {}

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
        inputSchema: inspectNugetNupkgInputSchema,
        outputSchema: nugetNupkgSchema,
        provider: this.provider,
        invalidOutputMessage:
          "NuGet nupkg provider returned malformed output or changed artifact identity.",
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
  report: NugetNupkg,
  input: {
    readonly max_file_bytes: number;
    readonly max_entries: number;
    readonly max_nuspec_bytes: number;
  },
): boolean => {
  if (
    report.artifact.bytes > input.max_file_bytes ||
    report.coverage.entries > input.max_entries ||
    report.contents.length > input.max_entries ||
    report.coverage.examined_nuspec_bytes > input.max_nuspec_bytes
  )
    return false;
  if (
    report.nuspec?.bytes !== null &&
    report.nuspec !== null &&
    report.nuspec.bytes > input.max_nuspec_bytes
  )
    return false;
  return report.coverage.entries === report.contents.length;
};
