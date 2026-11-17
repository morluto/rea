import {
  machoSelectionAnswersArchitecture,
  metadataReportSubjectFormat,
} from "../../domain/apple/machoTargetSelection.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  dwarfLinesSchema,
  formatDwarfLineAddress,
  inspectDwarfLinesInputSchema,
  type DwarfLinesReport,
  type InspectDwarfLinesInput,
} from "../../domain/native/dwarfLines.js";
import type { Result } from "../../domain/result.js";
import { err } from "../../domain/result.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { DwarfLinesPort } from "../../ports/binaryDiagnostics/DwarfLinesPort.js";
import {
  callerAnalysisParameters,
  parseAnalysisInput,
} from "../AnalysisInput.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

const OPERATION = "inspect_dwarf_lines";

/** Shared caller validation, output verification, and Evidence provenance for `.debug_line`. */
export class DwarfLinesService {
  constructor(readonly provider: DwarfLinesPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const callerParameters = callerAnalysisParameters(rawInput);
    const input = parseAnalysisInput(
      OPERATION,
      rawInput,
      inspectDwarfLinesInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const result = await this.provider.inspect(input.value, options);
    if (!result.ok) return result;
    const report = dwarfLinesSchema.safeParse(result.value);
    if (!report.success || !validReport(report.data, input.value)) {
      return err(
        new AnalysisOutputError(
          OPERATION,
          "DWARF line provider returned malformed output or violated requested bounds.",
        ),
      );
    }
    const value = report.data;
    const locations = [
      { kind: "artifact-path" as const, path: value.artifact.path },
      ...value.sections.map((section) => ({
        kind: "file-offset-range" as const,
        start: section.offset,
        end: section.offset + section.size,
      })),
    ];
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          format: metadataReportSubjectFormat(value),
          sha256: value.artifact.sha256,
          ...(value.architecture === null
            ? {}
            : { architecture: value.architecture }),
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: callerParameters(input.value),
          result: value,
          confidence: "observed",
          limitations: value.limitations,
          locations,
        },
      ),
      options?.signal,
    );
  }
}

const validReport = (
  report: DwarfLinesReport,
  input: InspectDwarfLinesInput,
): boolean => {
  if (
    report.artifact.path !== input.path ||
    report.artifact.bytes > input.max_file_bytes ||
    report.selected_program_offset !== (input.program_offset ?? null) ||
    report.programs.length > input.max_programs ||
    report.rows.length > input.max_rows ||
    !machoSelectionAnswersArchitecture(
      report.selected_slice,
      input.architecture,
    )
  ) {
    return false;
  }
  const expectedQueries = (input.addresses ?? []).map((raw) =>
    formatDwarfLineAddress(BigInt(raw)),
  );
  if (report.address_matches.length !== expectedQueries.length) return false;
  return expectedQueries.every(
    (expected, index) =>
      report.address_matches[index]?.query_address === expected,
  );
};
