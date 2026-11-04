import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import { UNICORN_TOOL_CONTRACTS } from "../contracts/unicorn/unicornToolContracts.js";
import { registerEvidenceTools } from "./registerEvidenceTools.js";
import type { EvidenceToolFamilyOptions } from "./retainedSummaryDelivery.js";

/** Register the Unicorn emulation contract through the shared Evidence workflow. */
export const registerUnicornTools = (
  server: EvidenceMcpServer,
  options: EvidenceToolFamilyOptions,
): void => {
  registerEvidenceTools(server, UNICORN_TOOL_CONTRACTS, options);
};
