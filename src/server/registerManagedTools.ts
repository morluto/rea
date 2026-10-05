import type { McpServer } from "@modelcontextprotocol/server";

import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import { MANAGED_TOOL_CONTRACTS } from "../contracts/managedToolContracts.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { err } from "../domain/result.js";
import type { Logger } from "../logger.js";
import { registerEvidenceTools } from "./registerEvidenceTools.js";
import { runManagedProviderExecution } from "../application/DirectAnalysis.js";
import { isManagedToolName } from "../contracts/managedToolContracts.js";

/** Register execution-free managed PE/CLI inspection. */
export const registerManagedTools = (
  server: McpServer,
  analysis: AnalysisOperationPort,
  options: {
    readonly logger: Logger;
    readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
    readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
    readonly session: BinarySessionPort | undefined;
  },
): void => {
  let selectedManagedPath: string | undefined;
  const managedAnalysis: AnalysisOperationPort = {
    execute: async (operation, parameters, executionOptions) => {
      if (!isManagedToolName(operation))
        return analysis.execute(operation, parameters, executionOptions);
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
      );
      if (execution.ok && typeof requestedPath === "string")
        selectedManagedPath = requestedPath;
      return execution;
    },
  };
  registerEvidenceTools(
    server,
    managedAnalysis,
    MANAGED_TOOL_CONTRACTS,
    options,
  );
};
