import { inspectModelArtifactInputSchema } from "../../domain/model/modelArtifactQuery.js";
import type { ModelArtifactPort } from "../../ports/model/ModelArtifactPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { modelArtifactSchema } from "../../domain/model/modelArtifact.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import { createModelArtifactEvidence } from "../../domain/model/modelArtifactEvidence.js";
import type { Result } from "../../domain/result.js";
import type { AnalysisViewRetention } from "../analysisView/AnalysisViewService.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

/** Shared input, Evidence and retained delivery boundary for CLI, MCP and SDK callers. */
export class ModelArtifactService {
  constructor(readonly provider: ModelArtifactPort) {}

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
        operation: "inspect_model_artifact",
        inputSchema: inspectModelArtifactInputSchema,
        outputSchema: modelArtifactSchema,
        provider: this.provider,
        invalidOutputMessage:
          "Model reader changed the selected input or returned invalid facts",
        toParameters: ({ detail: _detail, view: _view, ...parameters }) =>
          parameters,
        selectRetainedView: ({ detail, view }) =>
          detail === "summary"
            ? view === undefined
              ? { kind: "summary" }
              : { kind: "model-artifact", ...view }
            : undefined,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          report.artifact.read_scope ===
            (parameters.hash === "full" ? "full-file" : "header") &&
          (parameters.hash === "header"
            ? report.artifact.sha256 === null
            : report.artifact.sha256 !== null),
        buildEvidence: createModelArtifactEvidence,
      },
      raw,
      options,
      retention,
    );
  }
}
