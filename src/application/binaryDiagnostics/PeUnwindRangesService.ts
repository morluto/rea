import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { PeUnwindRangesPort } from "../../ports/binaryDiagnostics/PeUnwindRangesPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import {
  inspectPeUnwindRangesInputSchema,
  peUnwindRangesSchema,
  type InspectPeUnwindRangesInput,
  type PeUnwindRanges,
} from "../../domain/native/peUnwindRanges.js";
import { observedPeEvidence } from "./observedPeEvidence.js";
import type { Result } from "../../domain/result.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_pe_unwind_ranges";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class PeUnwindRangesService {
  constructor(readonly provider: PeUnwindRangesPort) {}

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
        inputSchema: inspectPeUnwindRangesInputSchema,
        outputSchema: peUnwindRangesSchema,
        provider: this.provider,
        retainCompletedReport: true,
        invalidOutputMessage:
          "PE exception-directory provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          validReport(report, parameters),
        buildEvidence: (value, identity, parameters) => {
          const directory = value.exception_directory;
          return observedPeEvidence(
            value,
            identity,
            OPERATION,
            parameters,
            directory.file_offset === null || directory.size === null
              ? []
              : [
                  {
                    kind: "file-offset-range",
                    start: directory.file_offset,
                    end: directory.file_offset + directory.size,
                  },
                ],
          );
        },
      },
      rawInput,
      options,
    );
  }
}

/** The counts, page and chain links the reader reports must agree with each other. */
const validReport = (
  report: PeUnwindRanges,
  input: InspectPeUnwindRangesInput,
): boolean => {
  const { coverage, page, entries } = report;
  if (
    coverage.primary_entries +
      coverage.chained_entries +
      coverage.unknown_entries !==
      coverage.total_entries ||
    coverage.entries_with_issues > coverage.total_entries ||
    page.kind !== input.kind ||
    page.offset !== input.offset ||
    page.limit !== input.limit ||
    page.returned !== entries.length ||
    page.total > coverage.total_entries ||
    entries.length !==
      Math.min(input.limit, Math.max(0, page.total - input.offset)) ||
    page.next_offset !==
      (input.offset + entries.length < page.total
        ? input.offset + entries.length
        : null)
  )
    return false;
  const directory = report.exception_directory.status;
  if (directory !== "present")
    return (
      coverage.total_entries === 0 &&
      entries.length === 0 &&
      (coverage.status === "complete") === (directory === "absent")
    );
  if ((coverage.status === "complete") !== (coverage.unknown_entries === 0))
    return false;
  return entries.every(
    (entry) =>
      entry.index < coverage.total_entries &&
      (entry.kind === "chained") === (entry.parent !== null) &&
      (entry.kind !== "primary" || entry.primary_index === entry.index) &&
      (entry.parent?.index ?? 0) < coverage.total_entries,
  );
};
