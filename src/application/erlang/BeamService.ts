import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { BeamPort } from "../../ports/erlang/BeamPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectErlangBeamInputSchema,
  erlangBeamSchema,
  type ErlangBeam,
} from "../../domain/erlang/beam.js";
import type { Result } from "../../domain/result.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_erlang_beam";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class BeamService {
  constructor(readonly provider: BeamPort) {}

  close(): Promise<void> {
    return this.provider.close();
  }

  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectErlangBeamInputSchema,
        outputSchema: erlangBeamSchema,
        provider: this.provider,
        invalidOutputMessage:
          "BEAM provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          validReport(
            report,
            parameters.max_chunks,
            parameters.max_atoms,
            parameters.max_file_bytes,
          ),
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
              parameters,
              result: value,
              confidence: "observed",
              limitations: value.limitations,
              locations: [
                { kind: "artifact-path" as const, path: value.artifact.path },
                {
                  kind: "file-offset-range" as const,
                  start: value.form.location.offset,
                  end: value.form.location.offset + value.form.location.bytes,
                },
              ],
            },
          ),
      },
      rawInput,
      options,
    );
  }
}

const validReport = (
  report: ErlangBeam,
  maxChunks: number,
  maxAtoms: number,
  maxBytes: number,
): boolean => {
  const inside = ({ offset, bytes }: { offset: number; bytes: number }) =>
    offset <= report.artifact.bytes - bytes;
  if (
    report.artifact.bytes > maxBytes ||
    report.coverage.examined_chunks > maxChunks ||
    report.chunks.length > maxChunks ||
    report.coverage.atoms > maxAtoms ||
    (report.atoms !== null && report.atoms.length > maxAtoms)
  )
    return false;
  if (!inside(report.form.location)) return false;
  if (report.code !== null && !inside(report.code.instructions)) return false;
  return report.chunks.every(
    (chunk) => inside(chunk.location) && inside(chunk.payload.location),
  );
};
