import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { CanonicalizePort } from "../../ports/canonicalize/CanonicalizePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  canonicalizeArtifactInputSchema,
  canonicalizeArtifactSchema,
} from "../../domain/canonicalize/canonicalizeArtifact.js";
import type { Result } from "../../domain/result.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "canonicalize_artifact";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class CanonicalizeService {
  constructor(readonly provider: CanonicalizePort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  canonicalize(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: canonicalizeArtifactInputSchema,
        outputSchema: canonicalizeArtifactSchema,
        provider: {
          identity: this.provider.identity,
          inspect: (
            input: Parameters<CanonicalizePort["canonicalize"]>[0],
            execOptions,
          ) => this.provider.canonicalize(input, execOptions),
        },
        invalidOutputMessage:
          "Canonicalizer returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          report.artifact.bytes <= parameters.max_file_bytes &&
          report.requested_format === parameters.format,
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
              ],
            },
          ),
      },
      rawInput,
      options,
    );
  }
}
