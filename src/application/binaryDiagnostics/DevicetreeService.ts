import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { DevicetreePort } from "../../ports/binaryDiagnostics/DevicetreePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectDevicetreeInputSchema,
  devicetreeSchema,
} from "../../domain/firmware/devicetree.js";
import type { Result } from "../../domain/result.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_devicetree";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class DevicetreeService {
  constructor(readonly provider: DevicetreePort) {}

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
        inputSchema: inspectDevicetreeInputSchema,
        outputSchema: devicetreeSchema,
        provider: this.provider,
        invalidOutputMessage:
          "devicetree provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, input) =>
          report.artifact.path === input.path &&
          report.artifact.bytes <= input.max_file_bytes &&
          report.nodes.length <= input.max_nodes &&
          report.coverage.examined_properties <= input.max_properties,
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
