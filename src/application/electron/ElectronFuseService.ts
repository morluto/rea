import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { ElectronFusePort } from "../../ports/electron/ElectronFusePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  electronFuseReportSchema,
  inspectElectronFusesInputSchema,
} from "../../domain/electron/electronFuses.js";
import type { Evidence } from "../../domain/evidence.js";
import { createElectronFuseEvidence } from "../../domain/electron/electronFuseEvidence.js";
import type { Result } from "../../domain/result.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_electron_fuses";

/** Shared exact input validation and artifact-bound Evidence for CLI and MCP. */
export class ElectronFuseService {
  constructor(readonly provider: ElectronFusePort) {}

  /** Await and retry the reader's exact retained descriptor owners. */
  async close(): Promise<void> {
    await this.provider.close();
  }

  /** Read fuse wires for one explicitly selected path without launching it. */
  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectElectronFusesInputSchema,
        outputSchema: electronFuseReportSchema,
        provider: this.provider,
        invalidOutputMessage:
          "Electron fuse reader returned a malformed report or changed the selected artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.selected_path === parameters.path,
        buildEvidence: (report, identity, parameters) =>
          createElectronFuseEvidence(parameters, report, identity),
      },
      rawInput,
      options,
    );
  }
}
