import type { McpServer } from "@modelcontextprotocol/server";

import { projectAppleApplicationEvidence } from "../application/AppleApplicationService.js";
import {
  APPLE_APPLICATION_TOOL_CONTRACTS,
  appleApplicationReferenceInputSchema,
} from "../contracts/appleApplicationToolContracts.js";
import {
  registerInventoryEvidenceTool,
  type InventoryEvidenceToolRegistration,
} from "./registerInventoryEvidenceTool.js";

/** Register the authenticated IPA application projection workflow. */
export const registerAppleApplicationTools = (
  server: McpServer,
  options: InventoryEvidenceToolRegistration,
): void =>
  registerInventoryEvidenceTool(server, options, {
    contract: APPLE_APPLICATION_TOOL_CONTRACTS[0],
    inputSchema: appleApplicationReferenceInputSchema,
    derive: projectAppleApplicationEvidence,
  });
