import { insideArtifact } from "./artifactRange.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { NeExecutablePort } from "../../ports/binaryDiagnostics/NeExecutablePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectNeExecutableInputSchema,
  neExecutableSchema,
  type NeExecutable,
} from "../../domain/native/neExecutable.js";
import type { Result } from "../../domain/result.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_ne_executable";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class NeExecutableService {
  constructor(readonly provider: NeExecutablePort) {}

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
        inputSchema: inspectNeExecutableInputSchema,
        outputSchema: neExecutableSchema,
        provider: this.provider,
        invalidOutputMessage:
          "NE provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          validReport(report, parameters.max_rows, parameters.max_file_bytes),
        buildEvidence: (value, identity, parameters) =>
          createEvidence(
            {
              path: value.artifact.path,
              format: "ne",
              sha256: value.artifact.sha256,
            },
            identity,
            {
              operation: OPERATION,
              parameters,
              result: value,
              confidence: "observed",
              limitations: value.limitations,
              locations: [{ kind: "artifact-path", path: value.artifact.path }],
            },
          ),
      },
      rawInput,
      options,
    );
  }
}

/** Check cross-field invariants before provider output becomes public Evidence. */
const validReport = (
  report: NeExecutable,
  maxRows: number,
  maxBytes: number,
): boolean => {
  const inside = insideArtifact(report.artifact.bytes);
  const rows =
    report.segments.length +
    report.resources.length +
    report.resident_names.length +
    report.nonresident_names.length +
    (report.module_name === null ? 0 : 1) +
    (report.description === null ? 0 : 1) +
    report.module_references.length +
    report.entries.length;
  if (
    report.artifact.bytes > maxBytes ||
    report.coverage.examined_rows > maxRows ||
    report.coverage.examined_rows !== rows ||
    !inside(report.header.location)
  )
    return false;
  const names = [
    report.module_name,
    report.description,
    ...report.resident_names,
    ...report.nonresident_names,
    ...report.module_references,
  ];
  return (
    names.every((name) => name === null || inside(name.location)) &&
    report.segments.every(
      (segment, index) =>
        segment.index === index + 1 &&
        (segment.location === null || inside(segment.location)) &&
        (segment.relocations === null ||
          (segment.location !== null &&
            inside(segment.relocations.location) &&
            segment.relocations.location.offset ===
              segment.location.offset + segment.location.bytes)),
    ) &&
    report.resources.every(
      (resource) =>
        (resource.location === null || inside(resource.location)) &&
        inside(resource.entry_location) &&
        [resource.type, resource.name].every(
          (identity) => identity.kind !== "name" || inside(identity.location),
        ),
    ) &&
    report.module_references.every(
      (reference, index) => reference.index === index + 1,
    ) &&
    report.entries.every(
      (entry, index) =>
        inside(entry.location) &&
        (index === 0 ||
          entry.ordinal > (report.entries[index - 1]?.ordinal ?? 0)),
    )
  );
};
