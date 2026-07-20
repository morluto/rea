import type { McpServer } from "@modelcontextprotocol/server";

import { projectAndroidApplicationEvidence } from "../application/AndroidApplicationService.js";
import {
  ANDROID_APPLICATION_TOOL_CONTRACTS,
  androidApplicationReferenceInputSchema,
} from "../contracts/androidApplicationToolContracts.js";
import {
  registerInventoryEvidenceTool,
  type InventoryEvidenceToolRegistration,
} from "./registerInventoryEvidenceTool.js";

/** Register the authenticated APK application projection workflow. */
export const registerAndroidApplicationTools = (
  server: McpServer,
  options: InventoryEvidenceToolRegistration,
): void =>
  registerInventoryEvidenceTool(server, options, {
    contract: ANDROID_APPLICATION_TOOL_CONTRACTS[0],
    inputSchema: androidApplicationReferenceInputSchema,
    derive: projectAndroidApplicationEvidence,
  });
