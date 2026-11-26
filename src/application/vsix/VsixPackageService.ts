import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { VsixPackagePort } from "../../ports/vsix/VsixPackagePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import {
  inspectVsixPackageInputSchema,
  vsixPackageSchema,
  type VsixPackage,
} from "../../domain/vsix/vsixPackage.js";
import type { Result } from "../../domain/result.js";
import { callerAnalysisParameters } from "../AnalysisInput.js";
import { observedFileEvidence } from "../observedFileEvidence.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_vsix_package";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class VsixPackageService {
  constructor(readonly provider: VsixPackagePort) {}

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
        inputSchema: inspectVsixPackageInputSchema,
        outputSchema: vsixPackageSchema,
        provider: this.provider,
        invalidOutputMessage:
          "VS Code vsix provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          validReport(report, parameters),
        buildEvidence: (value, identity, parameters) =>
          observedFileEvidence(
            value,
            identity,
            OPERATION,
            selectedParameters(parameters),
          ),
      },
      rawInput,
      options,
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
