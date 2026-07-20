import type { McpServer } from "@modelcontextprotocol/server";

import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import { MANAGED_TOOL_CONTRACTS } from "../contracts/managedToolContracts.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { Logger } from "../logger.js";
import { err } from "../domain/result.js";
import { registerEvidenceTools } from "./registerEvidenceTools.js";

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
  const targetAwareAnalysis: AnalysisOperationPort = {
    execute: async (operation, parameters, executionOptions) => {
      const path =
        operation === "inspect_managed_artifact" &&
        typeof parameters.path === "string"
          ? parameters.path
          : undefined;
      if (path !== undefined && options.session !== undefined) {
        const opened = await options.session.open(
          path,
          executionOptions?.signal === undefined
            ? undefined
            : { signal: executionOptions.signal },
        );
        if (!opened.ok) return err(opened.error);
      }
      return analysis.execute(operation, parameters, executionOptions);
    },
  };
  registerEvidenceTools(
    server,
    targetAwareAnalysis,
    MANAGED_TOOL_CONTRACTS,
    options,
  );
};
