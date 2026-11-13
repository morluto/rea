import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { NugetNupkgPort } from "./NugetNupkgPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectNugetNupkgInputSchema,
  nugetNupkgSchema,
  type NugetNupkg,
} from "../../domain/nuget/nupkg.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

const OPERATION = "inspect_nuget_nupkg";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class NugetNupkgService {
  constructor(readonly provider: NugetNupkgPort) {}

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
      inspectNugetNupkgInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const result = await this.provider.inspect(input.value, options);
    if (!result.ok) return result;
    const report = nugetNupkgSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      !validReport(report.data, input.value)
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "NuGet nupkg provider returned malformed output or changed artifact identity.",
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
          ],
        },
      ),
      options?.signal,
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
  if (report.nuspec !== null && report.nuspec.bytes > input.max_nuspec_bytes)
    return false;
  return report.coverage.entries === report.contents.length;
};
