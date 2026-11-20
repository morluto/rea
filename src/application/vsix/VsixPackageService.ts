import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { VsixPackagePort } from "../../ports/vsix/VsixPackagePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectVsixPackageInputSchema,
  vsixPackageSchema,
  type VsixPackage,
} from "../../domain/vsix/vsixPackage.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import {
  callerAnalysisParameters,
  parseAnalysisInput,
} from "../AnalysisInput.js";

const OPERATION = "inspect_vsix_package";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class VsixPackageService {
  constructor(readonly provider: VsixPackagePort) {}

  close(): Promise<void> {
    return this.provider.close();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const selectedParameters = callerAnalysisParameters(rawInput);
    const input = parseAnalysisInput(
      OPERATION,
      rawInput,
      inspectVsixPackageInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const result = await this.provider.inspect(input.value, options);
    if (!result.ok) return result;
    const report = vsixPackageSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      !validReport(report.data, input.value)
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "VS Code vsix provider returned malformed output or changed artifact identity.",
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
          parameters: selectedParameters(input.value),
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
  report: VsixPackage,
  input: {
    readonly max_file_bytes: number;
    readonly max_entries: number;
    readonly max_manifest_bytes: number;
    readonly max_member_bytes: number;
  },
): boolean => {
  if (
    report.artifact.bytes > input.max_file_bytes ||
    report.coverage.entries > input.max_entries ||
    report.contents.length > input.max_entries ||
    // vsixmanifest, extension/package.json, and the directory main package.json.
    report.coverage.examined_manifest_bytes > input.max_manifest_bytes * 3
  )
    return false;
  if (
    report.vsixmanifest?.bytes !== null &&
    report.vsixmanifest !== null &&
    report.vsixmanifest.bytes > input.max_manifest_bytes
  )
    return false;
  if (
    report.package_json?.bytes !== null &&
    report.package_json !== null &&
    report.package_json.bytes > input.max_manifest_bytes
  )
    return false;
  if (
    report.interesting_members.some(
      (member) =>
        member.sha256 !== null &&
        member.bytes !== null &&
        member.bytes > input.max_member_bytes,
    )
  )
    return false;
  return report.coverage.entries === report.contents.length;
};
