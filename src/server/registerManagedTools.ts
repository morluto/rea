import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import {
  requireAnalysisViewRetention,
  summarizeRetainedAnalysis,
} from "../application/analysisView/AnalysisViewService.js";

import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import { MANAGED_TOOL_CONTRACTS } from "../contracts/managed/managedToolContracts.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { err, ok } from "../domain/result.js";
import type { Logger } from "pino";
import { registerEvidenceTools } from "./registerEvidenceTools.js";
import { runManagedProviderExecution } from "../composition/directAnalysis.js";
import { isManagedToolName } from "../contracts/managed/managedToolContracts.js";

/** Register execution-free managed PE/CLI inspection. */
export const registerManagedTools = (
  server: EvidenceMcpServer,
  options: {
    readonly logger: Logger;
    readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
    readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
    readonly evidenceById?: EvidenceLookup | undefined;
    readonly withAdmittedAnalysis: import("./analysisAdmission.js").WithAdmittedAnalysis;
  },
): void => {
  let selectedManagedPath: string | undefined;
  const analysisForAdmission = (
    analysis: AnalysisOperationPort,
  ): AnalysisOperationPort => ({
    execute: async (operation, parameters, executionOptions) => {
      if (!isManagedToolName(operation))
        return analysis.execute(operation, parameters, executionOptions);
      const { detail: _detail, ...artifactParameters } = parameters;
      if (
        operation === "inspect_managed_artifact" &&
        parameters.detail === "summary"
      ) {
        const ready = requireAnalysisViewRetention(operation, {
          recordEvidence: options.recordEvidence,
          evidenceById: options.evidenceById,
        });
        if (!ready.ok) return ready;
      }
      const requestedPath = parameters.path;
      const activeTarget = options.activeTarget?.();
      const path =
        typeof requestedPath === "string"
          ? requestedPath
          : (selectedManagedPath ??
            (activeTarget?.format === "pe" && activeTarget.managed
              ? activeTarget.path
              : undefined));
      if (path === undefined)
        return err(
          new AnalysisInputError(operation, undefined, [
            {
              path: ["path"],
              reason: "missing_argument",
              message:
                "Provide a managed PE/CLI path or first select one with inspect_managed_artifact.",
            },
          ]),
        );
      const execution = await runManagedProviderExecution(
        path,
        operation,
        executionOptions?.signal,
        operation === "inspect_managed_artifact"
          ? artifactParameters
          : parameters,
      );
      if (execution.ok && typeof requestedPath === "string")
        selectedManagedPath = requestedPath;
      return execution;
    },
  });
  registerEvidenceTools(server, MANAGED_TOOL_CONTRACTS, {
    ...options,
    analysisForAdmission,
    projectEvidence: (operation, parameters, evidence) =>
      operation === "inspect_managed_artifact" &&
      parameters.detail === "summary"
        ? summarizeRetainedAnalysis(evidence, {
            recordEvidence: options.recordEvidence,
            evidenceById: options.evidenceById,
          })
        : ok(evidence),
  });
};
