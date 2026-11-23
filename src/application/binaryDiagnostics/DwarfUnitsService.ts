import { machoSliceFamily } from "../../domain/apple/machoTargetSelection.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { DwarfUnitsPort } from "../../ports/binaryDiagnostics/DwarfUnitsPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { metadataReportSubjectFormat } from "../../domain/apple/machoTargetSelection.js";
import { binaryMetadataArchitecture } from "../../domain/binaryMetadataArchitecture.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  dwarfUnitsSchema,
  inspectDwarfUnitsInputSchema,
  type DwarfUnitsReport,
  type InspectDwarfUnitsInput,
} from "../../domain/native/dwarfUnits.js";
import type { Result } from "../../domain/result.js";
import { callerAnalysisParameters } from "../AnalysisInput.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_dwarf_units";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class DwarfUnitsService {
  constructor(readonly provider: DwarfUnitsPort) {}

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
        inputSchema: inspectDwarfUnitsInputSchema,
        outputSchema: dwarfUnitsSchema,
        provider: this.provider,
        invalidOutputMessage:
          "DWARF compile-unit provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          validReport(report, parameters),
        buildEvidence: (value, identity, parameters) => {
          const architecture =
            value.architecture === null
              ? undefined
              : binaryMetadataArchitecture(value.architecture);
          const locations = [
            { kind: "artifact-path" as const, path: value.artifact.path },
            ...value.sections.flatMap((section) =>
              section.size === 0
                ? []
                : [
                    {
                      kind: "file-offset-range" as const,
                      start: section.offset,
                      end: section.offset + section.size,
                    },
                  ],
            ),
            ...value.units.flatMap((unit) =>
              unit.file_offset === null
                ? []
                : [
                    {
                      kind: "file-offset-range" as const,
                      start: unit.file_offset,
                      end: unit.file_offset + unit.length,
                    },
                  ],
            ),
          ];
          return createEvidence(
            {
              path: value.artifact.path,
              format: metadataReportSubjectFormat(value),
              sha256: value.artifact.sha256,
              ...(architecture === undefined ? {} : { architecture }),
            },
            identity,
            {
              operation: OPERATION,
              parameters: callerAnalysisParameters(rawInput)(parameters),
              result: value,
              confidence: "observed",
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

const validReport = (
  report: DwarfUnitsReport,
  input: InspectDwarfUnitsInput,
): boolean => {
  if (report.artifact.bytes > input.max_file_bytes) return false;
  if (report.page.offset !== input.offset || report.page.limit !== input.limit)
    return false;
  const requested = input.architecture;
  const slice = report.selected_slice;
  if ((requested === undefined) !== (slice === undefined)) return false;
  // Reports name the CPU family; arm64e selects an arm64 slice.
  return (
    requested === undefined ||
    report.architecture === machoSliceFamily(requested)
  );
};
