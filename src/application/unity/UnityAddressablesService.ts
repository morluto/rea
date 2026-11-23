import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { AnalysisViewRetention } from "../analysisView/AnalysisViewService.js";
import type { UnityAddressablesPort } from "../../ports/unity/UnityAddressablesPort.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import { unityAddressablesCatalogEvidence } from "../../domain/unity/unityAddressablesEvidence.js";
import {
  inspectUnityAddressablesInputSchema,
  unityAddressablesSchema,
} from "../../domain/unity/unityAddressables.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import type { Result } from "../../domain/result.js";
import { errorMessage } from "../../kernel/errorMessage.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_unity_addressables";

/** Shared exact input validation, artifact-bound Evidence and summary delivery for CLI and MCP. */
export class UnityAddressablesService {
  constructor(readonly provider: UnityAddressablesPort) {}

  async close(): Promise<void> {
    try {
      await this.provider.close?.();
    } catch (cause) {
      if (cause instanceof AnalysisError) throw cause;
      throw new ProviderCleanupError(
        this.provider.identity.id,
        [],
        { reason: errorMessage(cause) },
        { cause, operation: OPERATION },
      );
    }
  }

  /**
   * Inspect one explicitly selected catalog; detail changes delivery, not
   * decoded coverage. A provider failure is returned unchanged, so the partial
   * Evidence the reader attached (decoded catalog or source facts) survives.
   */
  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
    retention?: AnalysisViewRetention,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectUnityAddressablesInputSchema,
        outputSchema: unityAddressablesSchema,
        provider: this.provider,
        invalidOutputMessage:
          "Unity Addressables reader returned a malformed catalog report or changed the selected artifact identity.",
        toParameters: ({ detail: _detail, ...providerInput }) => providerInput,
        selectRetainedView: ({ detail }) =>
          detail === "summary" ? { kind: "summary" } : undefined,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          (report.hash_file?.artifact.path ?? undefined) ===
            parameters.hash_path,
        buildEvidence: unityAddressablesCatalogEvidence,
      },
      rawInput,
      options,
      retention,
    );
  }
}
