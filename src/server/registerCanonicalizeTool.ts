import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { CanonicalizeService } from "../application/canonicalize/CanonicalizeService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register the execution-free antidote canonicalizer and retain its complete Evidence. */
export const registerCanonicalizeTool = (
  server: EvidenceMcpServer,
  service: CanonicalizeService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("canonicalize_artifact");
  const handler = createEvidenceToolHandler(
    server,
    (input, options) => service.canonicalize(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    handler(contract),
  );
};
