import { insideArtifact } from "./artifactRange.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { ElfNotesPort } from "../../ports/binaryDiagnostics/ElfNotesPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectElfNotesInputSchema,
  elfNotesSchema,
  type ElfNotes,
} from "../../domain/native/elfNotes.js";
import { elfArchitecture } from "../../domain/elfFixedHeader.js";
import type { Result } from "../../domain/result.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_elf_notes";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class ElfNotesService {
  constructor(readonly provider: ElfNotesPort) {}

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
        inputSchema: inspectElfNotesInputSchema,
        outputSchema: elfNotesSchema,
        provider: this.provider,
        retainCompletedReport: true,
        invalidOutputMessage:
          "ELF note provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, input) =>
          report.artifact.path === input.path &&
          validReport(report, input.max_entries, input.max_file_bytes),
        buildEvidence: (value, identity, parameters) => {
          const architecture = elfArchitecture(value.machine);
          return createEvidence(
            {
              path: value.artifact.path,
              format: "elf",
              sha256: value.artifact.sha256,
              ...(architecture === undefined ? {} : { architecture }),
            },
            identity,
            {
              operation: OPERATION,
              parameters,
              result: value,
              confidence: "observed",
              limitations: value.limitations,
              locations: [
                { kind: "artifact-path" as const, path: value.artifact.path },
                ...value.tables.map((table) => ({
                  kind: "file-offset-range" as const,
                  start: table.location.offset,
                  end: table.location.offset + table.location.bytes,
                })),
              ],
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
  report: ElfNotes,
  maxEntries: number,
  maxBytes: number,
): boolean => {
  const inside = insideArtifact(report.artifact.bytes);
  if (
    report.artifact.bytes > maxBytes ||
    report.coverage.examined_entries > maxEntries ||
    report.entries.length !== report.coverage.examined_entries ||
    report.tables.length !== report.coverage.examined_tables
  )
    return false;
  return (
    report.tables.every((table) => inside(table.location)) &&
    report.entries.every(
      (entry) => inside(entry.location) && inside(entry.descriptor.location),
    )
  );
};
