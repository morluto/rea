import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { FirmwareArchitectureCandidatesPort } from "../../ports/binaryDiagnostics/FirmwareArchitectureCandidatesPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  firmwareArchitectureCandidatesSchema,
  inspectFirmwareArchitectureCandidatesInputSchema,
  type FirmwareArchitectureCandidates,
  type InspectFirmwareArchitectureCandidatesInput,
} from "../../domain/firmware/firmwareArchitectureCandidates.js";
import type { Result } from "../../domain/result.js";
import { callerAnalysisParameters } from "../AnalysisInput.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_firmware_architecture_candidates";

const reportLocations = (report: FirmwareArchitectureCandidates) => {
  const seen = new Set<string>();
  const ranges: {
    readonly kind: "file-offset-range";
    readonly start: number;
    readonly end: number;
  }[] = [];
  for (const candidate of report.candidates) {
    for (const loc of candidate.locations) {
      const key = `${loc.start}:${loc.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ranges.push({
        kind: "file-offset-range",
        start: loc.start,
        end: loc.end,
      });
    }
  }
  return [
    { kind: "artifact-path" as const, path: report.artifact.path },
    ...ranges,
  ];
};

const validReport = (
  report: FirmwareArchitectureCandidates,
  input: InspectFirmwareArchitectureCandidatesInput,
): boolean => {
  if (report.artifact.bytes > input.max_file_bytes) return false;
  if (report.coverage.total_bytes !== report.artifact.bytes) return false;
  if (report.coverage.examined_bytes > report.artifact.bytes) return false;
  if (report.coverage.examined_bytes > input.max_scan_bytes) return false;
  if ((report.status === "candidates_found") !== report.candidates.length > 0) {
    return false;
  }
  if (
    report.candidates.some((candidate, index) => candidate.rank !== index + 1)
  ) {
    return false;
  }
  return true;
};

/** Shared caller validation, output parsing, and Evidence provenance for CLI/MCP. */
export class FirmwareArchitectureCandidatesService {
  constructor(readonly provider: FirmwareArchitectureCandidatesPort) {}

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
        inputSchema: inspectFirmwareArchitectureCandidatesInputSchema,
        outputSchema: firmwareArchitectureCandidatesSchema,
        provider: this.provider,
        retainCompletedReport: true,
        invalidOutputMessage:
          "Firmware architecture candidate provider returned malformed output or changed artifact identity.",
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
              confidence: value.candidates[0]?.confidence ?? "observed",
              limitations: value.limitations,
              locations: reportLocations(value),
            },
          ),
      },
      rawInput,
      options,
    );
  }
}
