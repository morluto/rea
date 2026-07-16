import type { McpServer } from "@modelcontextprotocol/server";

import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import { MANAGED_TOOL_CONTRACTS } from "../contracts/managedToolContracts.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { Logger } from "../logger.js";
import { registerEvidenceTools } from "./registerEvidenceTools.js";

/** Register execution-free managed PE/CLI inspection. */
export const registerManagedTools = (
  server: McpServer,
  analysis: AnalysisOperationPort,
  options: {
    readonly logger: Logger;
    readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
    readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  },
): void => {
  registerEvidenceTools(server, analysis, MANAGED_TOOL_CONTRACTS, options);
};
