import type { McpServer } from "@modelcontextprotocol/server";

import { identifyRuntimeEvidence } from "../application/RuntimeIdentificationService.js";
import {
  RUNTIME_IDENTIFICATION_TOOL_CONTRACTS,
  runtimeIdentificationReferenceInputSchema,
} from "../contracts/runtimeIdentificationToolContracts.js";
import {
  registerInventoryEvidenceTool,
  type InventoryEvidenceToolRegistration,
} from "./registerInventoryEvidenceTool.js";

/** Register provider-neutral runtime identification over session Evidence. */
export const registerRuntimeIdentificationTools = (
  server: McpServer,
  options: InventoryEvidenceToolRegistration,
): void =>
  registerInventoryEvidenceTool(server, options, {
    contract: RUNTIME_IDENTIFICATION_TOOL_CONTRACTS[0],
    inputSchema: runtimeIdentificationReferenceInputSchema,
    derive: identifyRuntimeEvidence,
  });
