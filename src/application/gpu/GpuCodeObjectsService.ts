import {
  inspectGpuCodeObjectsInputSchema,
  gpuCodeObjectsSchema,
} from "../../domain/gpu/gpuCodeObjects.js";
import type { GpuCodeObjectsPort } from "../../ports/gpu/GpuCodeObjectsPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import { createGpuCodeObjectsEvidence } from "../../domain/gpu/gpuCodeObjectsEvidence.js";
import type { Result } from "../../domain/result.js";
import type { AnalysisViewRetention } from "../analysisView/AnalysisViewRetention.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

/** Shared input, Evidence and retained delivery boundary for CLI, MCP and SDK callers. */
export class GpuCodeObjectsService {
  constructor(readonly provider: GpuCodeObjectsPort) {}

  close(): Promise<void> {
    return this.provider.close();
  }

  inspect(
    raw: unknown,
    options?: ExecutionOptions,
    retention?: AnalysisViewRetention,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: "inspect_gpu_code_objects",
        inputSchema: inspectGpuCodeObjectsInputSchema,
        outputSchema: gpuCodeObjectsSchema,
        provider: this.provider,
        invalidOutputMessage:
          "GPU reader changed the selected input or returned invalid facts",
        toParameters: ({ detail: _detail, view: _view, ...parameters }) =>
          parameters,
        selectRetainedView: ({ detail, view }) =>
          detail === "summary"
            ? view === undefined
              ? { kind: "summary" }
              : { kind: "gpu-code-objects", ...view }
            : undefined,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          report.analysis === parameters.analysis &&
          (parameters.expected_sha256 === undefined ||
            report.artifact.sha256 === parameters.expected_sha256),
        buildEvidence: createGpuCodeObjectsEvidence,
      },
      raw,
      options,
      retention,
    );
  }
}
