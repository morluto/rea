import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { V8CodeCachePort } from "../../ports/v8CodeCache/V8CodeCachePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectV8CodeCacheInputSchema,
  v8CodeCacheSchema,
  type V8CodeCache,
} from "../../domain/v8/v8CodeCache.js";
import type { Result } from "../../domain/result.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_v8_code_cache";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class V8CodeCacheService {
  constructor(readonly provider: V8CodeCachePort) {}

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
        inputSchema: inspectV8CodeCacheInputSchema,
        outputSchema: v8CodeCacheSchema,
        provider: this.provider,
        invalidOutputMessage:
          "V8 code cache provider returned malformed output or changed artifact identity.",
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
              parameters,
              result: value,
              confidence: "observed",
              limitations: value.limitations,
              locations: [
                { kind: "artifact-path" as const, path: value.artifact.path },
                {
                  kind: "file-offset-range" as const,
                  start: value.payload.offset,
                  end: value.payload.offset + value.payload.bytes,
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
  report: V8CodeCache,
  input: {
    max_file_bytes: number;
    max_strings: number;
    min_string_bytes: number;
  },
): boolean => {
  if (report.artifact.bytes > input.max_file_bytes) return false;
  if (report.embedded_strings.length > input.max_strings) return false;
  if (
    report.payload.offset + report.payload.bytes !== report.artifact.bytes ||
    report.payload.offset !== report.header.header_bytes
  )
    return false;
  return report.embedded_strings.every(
    (observation) =>
      observation.bytes >= input.min_string_bytes &&
      observation.offset >= report.payload.offset &&
      observation.offset + observation.bytes <= report.artifact.bytes,
  );
};
