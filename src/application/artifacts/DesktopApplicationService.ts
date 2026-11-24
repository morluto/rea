import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { DesktopApplicationPort } from "../../ports/artifacts/DesktopApplicationPort.js";
import { ARTIFACT_GRAPH_PROVIDER } from "../../domain/investigationProviders.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";
import type { Evidence } from "../../domain/evidence.js";
import { createDesktopApplicationEvidence } from "../../domain/desktopApplicationEvidence.js";
import {
  desktopApplicationSchema,
  inspectDesktopApplicationInputSchema,
} from "../../domain/desktopApplication.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";

/** One input, interpretation and Evidence boundary shared by CLI, MCP and embedders. */
export class DesktopApplicationService {
  constructor(readonly reader: DesktopApplicationPort) {}
  close(): Promise<void> {
    return this.reader.close();
  }

  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: "inspect_desktop_application",
        inputSchema: inspectDesktopApplicationInputSchema,
        outputSchema: desktopApplicationSchema,
        provider: {
          identity: ARTIFACT_GRAPH_PROVIDER,
          inspect: (
            input: Parameters<DesktopApplicationPort["inspect"]>[0],
            execOptions,
          ) => this.reader.inspect(input, execOptions),
        },
        invalidOutputMessage:
          "Directory inspection changed the selected root or returned malformed facts.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.root.path === parameters.path,
        buildEvidence: (report, identity, parameters) =>
          createDesktopApplicationEvidence(parameters, report, identity),
      },
      rawInput,
      options,
    );
  }
}
