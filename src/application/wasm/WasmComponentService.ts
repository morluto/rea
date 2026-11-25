import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { WasmComponentPort } from "../../ports/wasm/WasmComponentPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import type { Result } from "../../domain/result.js";
import {
  inspectWasmComponentInputSchema,
  wasmComponentSchema,
} from "../../domain/wasm/wasmComponent.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";
import { observedFileEvidence } from "../observedFileEvidence.js";

const OPERATION = "inspect_wasm_component";

/** Shared exact input validation and artifact-bound Evidence for CLI and MCP. */
export class WasmComponentService {
  constructor(readonly provider: WasmComponentPort) {}

  close(): Promise<void> {
    return this.provider.close();
  }

  /** Decode one explicitly selected component without acquiring a binary session. */
  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectWasmComponentInputSchema,
        outputSchema: wasmComponentSchema,
        provider: this.provider,
        invalidOutputMessage:
          "Component decoder returned malformed facts or changed the selected artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path,
        buildEvidence: (report, identity, parameters) =>
          observedFileEvidence(
            report,
            identity,
            OPERATION,
            parameters,
            report.coverage.not_decoded.map(({ range }) => ({
              kind: "file-offset-range" as const,
              start: range.start,
              end: range.end,
            })),
          ),
      },
      rawInput,
      options,
    );
  }
}
