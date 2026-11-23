import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { NativeExportsPort } from "../../ports/binaryDiagnostics/NativeExportsPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectNativeExportsInputSchema,
  nativeExportsSchema,
} from "../../domain/native/nativeExports.js";
import type { Result } from "../../domain/result.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_native_exports";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class NativeExportsService {
  constructor(readonly provider: NativeExportsPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  /** Read one explicitly selected PE or ELF image's export table. */
  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectNativeExportsInputSchema,
        outputSchema: nativeExportsSchema,
        provider: this.provider,
        invalidOutputMessage:
          "Native export reader returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          report.artifact.bytes <= parameters.max_file_bytes,
        buildEvidence: (value, identity, parameters) =>
          createEvidence(
            {
              path: value.artifact.path,
              format: value.format,
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
