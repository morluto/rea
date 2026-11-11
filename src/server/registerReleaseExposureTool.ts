import type { ReleaseExposureService } from "../application/releaseExposure/ReleaseExposureService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register the read-only release-exposure audit and retain its Evidence. */
export const registerReleaseExposureTool = (
  server: EvidenceMcpServer,
  service: ReleaseExposureService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("audit_release_exposure");
  const handler = createEvidenceToolHandler(
    server,
    (input, options) => service.inspect(input, options),
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
