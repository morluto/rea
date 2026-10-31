import type { ExecutionOptions } from "../AnalysisProvider.js";
import {
  requireAnalysisViewRetention,
  summarizeRetainedAnalysis,
  type AnalysisViewRetention,
} from "../analysisView/AnalysisViewService.js";
import type { UnityAddressablesPort } from "./UnityAddressablesPort.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import type { Evidence } from "../../domain/evidence.js";
import { unityAddressablesCatalogEvidence } from "../../domain/unity/unityAddressablesEvidence.js";
import {
  inspectUnityAddressablesInputSchema,
  unityAddressablesSchema,
  type UnityAddressables,
  type UnityAddressablesProviderInput,
} from "../../domain/unity/unityAddressables.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok, type Result } from "../../domain/result.js";

const OPERATION = "inspect_unity_addressables";
const NO_RETENTION: AnalysisViewRetention = {
  evidenceById: undefined,
  recordEvidence: undefined,
};

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
        { reason: cause instanceof Error ? cause.message : String(cause) },
        { cause, operation: OPERATION },
      );
    }
  }

  /** Inspect one explicitly selected catalog; detail changes delivery, not decoded coverage. */
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
    retention: AnalysisViewRetention = NO_RETENTION,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    const input = inspectUnityAddressablesInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    const { detail, ...providerInput } = input.data;
    if (detail === "summary") {
      const ready = requireAnalysisViewRetention(OPERATION, retention);
      if (!ready.ok) return ready;
    }
    const inspected = await this.provider.inspect(providerInput, options);
    if (!inspected.ok) return inspected;
    const report = unityAddressablesSchema.safeParse(inspected.value);
    if (
      !report.success ||
      report.data.artifact.path !== providerInput.path ||
      (report.data.hash_file?.artifact.path ?? undefined) !==
        providerInput.hash_path
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Unity Addressables reader returned a malformed catalog report or changed the selected artifact identity.",
        ),
      );
    const evidence = this.#evidence(report.data, providerInput);
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, {
          cause: options.signal.reason,
          partialObservation: evidence,
        }),
      );
    return detail === "summary"
      ? summarizeRetainedAnalysis(evidence, retention)
      : ok(evidence);
  }

  #evidence(
    value: UnityAddressables,
    providerInput: UnityAddressablesProviderInput,
  ): Evidence {
    return unityAddressablesCatalogEvidence(
      value,
      this.provider.identity,
      providerInput,
    );
  }
}
