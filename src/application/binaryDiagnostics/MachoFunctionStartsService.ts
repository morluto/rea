import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { MachoFunctionStartsPort } from "../../ports/binaryDiagnostics/MachoFunctionStartsPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import {
  MACHO_FUNCTION_STARTS_LIMITATIONS,
  inspectMachoFunctionStartsInputSchema,
  machoFunctionStartsHasIssues,
  machoFunctionStartsSchema,
  type InspectMachoFunctionStartsInput,
  type MachoDataInCode,
  type MachoFunctionStarts,
} from "../../domain/native/machoFunctionStarts.js";
import { metadataReportSubjectFormat } from "../../domain/apple/machoTargetSelection.js";
import { observedFileEvidence } from "../observedFileEvidence.js";
import type { Result } from "../../domain/result.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_macho_function_starts";
const NAMED_KINDS = new Set([1, 2, 3, 4, 5]);

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class MachoFunctionStartsService {
  constructor(readonly provider: MachoFunctionStartsPort) {}

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
        inputSchema: inspectMachoFunctionStartsInputSchema,
        outputSchema: machoFunctionStartsSchema,
        provider: this.provider,
        retainCompletedReport: true,
        invalidOutputMessage:
          "Mach-O function-start provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          validReport(report, parameters),
        buildEvidence: (value, identity, parameters) =>
          observedFileEvidence(
            value,
            identity,
            OPERATION,
            parameters,
            locations(value),
            {
              format: metadataReportSubjectFormat({
                format: value.format,
                ...(value.selected_slice === undefined
                  ? {}
                  : { selected_slice: value.selected_slice }),
              }),
              ...(value.architecture === null
                ? {}
                : { architecture: value.architecture }),
            },
          ),
      },
      rawInput,
      options,
    );
  }
}

const locations = (report: MachoFunctionStarts) => {
  const ranges = [];
  for (const command of [report.function_starts, report.data_in_code]) {
    if (
      command.file_offset === null ||
      command.datasize === null ||
      command.datasize === 0 ||
      command.file_offset >= report.artifact.bytes
    )
      continue;
    ranges.push({
      kind: "file-offset-range" as const,
      start: command.file_offset,
      end: Math.min(
        report.artifact.bytes,
        command.file_offset + command.datasize,
      ),
    });
  }
  return ranges;
};

const pageLength = (total: number, offset: number, limit: number): number =>
  Math.min(limit, Math.max(0, total - offset));

const commandAgrees = (
  command: MachoFunctionStarts["function_starts"],
  total: number,
): boolean =>
  command.status === "absent"
    ? total === 0 &&
      command.dataoff === null &&
      command.datasize === null &&
      command.file_offset === null &&
      command.in_linkedit === null
    : (command.dataoff === null) === (command.datasize === null) &&
      (command.dataoff === null || typeof command.in_linkedit === "boolean");

const kindAgrees = (kind: MachoDataInCode["kind"]): boolean =>
  typeof kind === "string" ||
  (typeof kind === "number" && !NAMED_KINDS.has(kind));

/** The counts and page the reader reports must agree with each other. */
const validReport = (
  report: MachoFunctionStarts,
  input: InspectMachoFunctionStartsInput,
): boolean => {
  const { coverage, page, starts, data_in_code_entries: data } = report;
  const startsIncluded = input.kind !== "data";
  const dataIncluded = input.kind !== "starts";
  const startCount = startsIncluded
    ? pageLength(coverage.total_starts, input.offset, input.limit)
    : 0;
  const dataCount = dataIncluded
    ? pageLength(coverage.total_data_in_code, input.offset, input.limit)
    : 0;
  if (
    machoFunctionStartsHasIssues(coverage) ===
      (coverage.status === "complete") ||
    page.kind !== input.kind ||
    page.offset !== input.offset ||
    page.limit !== input.limit ||
    page.total_starts !== coverage.total_starts ||
    page.total_data !== coverage.total_data_in_code ||
    page.returned_starts !== starts.length ||
    page.returned_data !== data.length ||
    starts.length !== startCount ||
    data.length !== dataCount ||
    page.next_starts_offset !==
      (startsIncluded && input.offset + starts.length < coverage.total_starts
        ? input.offset + starts.length
        : null) ||
    page.next_data_offset !==
      (dataIncluded && input.offset + data.length < coverage.total_data_in_code
        ? input.offset + data.length
        : null) ||
    !commandAgrees(report.function_starts, coverage.total_starts) ||
    !commandAgrees(report.data_in_code, coverage.total_data_in_code) ||
    !report.limitations.includes(
      MACHO_FUNCTION_STARTS_LIMITATIONS.missingStarts,
    ) ||
    !report.limitations.includes(
      MACHO_FUNCTION_STARTS_LIMITATIONS.missingData,
    ) ||
    !report.limitations.includes(MACHO_FUNCTION_STARTS_LIMITATIONS.static)
  )
    return false;
  return (
    starts.every((entry, index) => entry.index === input.offset + index) &&
    data.every(
      (entry, index) =>
        entry.index === input.offset + index &&
        kindAgrees(entry.kind) &&
        (entry.owner === null || entry.owner.index < coverage.total_starts),
    )
  );
};
