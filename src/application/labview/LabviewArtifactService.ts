import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { LabviewArtifactPort } from "../../ports/labview/LabviewArtifactPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import {
  inspectLabviewArtifactInputSchema,
  labviewArtifactSchema,
} from "../../domain/labview/labviewArtifact.js";
import type { Result } from "../../domain/result.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";
import { observedFileEvidence } from "../observedFileEvidence.js";

const OPERATION = "inspect_labview_artifact";

/** Shared caller validation, output parsing and Evidence provenance for CLI and MCP. */
export class LabviewArtifactService {
  constructor(readonly provider: LabviewArtifactPort) {}

  close(): Promise<void> {
    return this.provider.close();
  }

  /** Inspect one explicitly selected file without acquiring a binary session. */
  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectLabviewArtifactInputSchema,
        outputSchema: labviewArtifactSchema,
        provider: this.provider,
        invalidOutputMessage:
          "LabVIEW RSRC reader returned malformed output or changed the selected artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path,
        buildEvidence: (report, identity, parameters) =>
          observedFileEvidence(report, identity, OPERATION, parameters),
      },
      rawInput,
      options,
    );
  }
}
