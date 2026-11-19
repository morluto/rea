import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { UefiAnalysisService } from "../application/uefi/UefiAnalysisService.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { createContractToolHandler } from "./contractToolHandler.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind UEFI firmware handlers to their exact named schemas. */
export const registerUefiTools = (
  server: EvidenceMcpServer,
  service: UefiAnalysisService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const handler = createContractToolHandler(
    server,
    service,
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  const inspect = toolContract("inspect_uefi_firmware");
  server.registerTool(
    inspect.name,
    toolRegistrationOptions(inspect),
    handler(inspect),
  );
  const extract = toolContract("extract_uefi_firmware");
  server.registerTool(
    extract.name,
    toolRegistrationOptions(extract),
    handler(extract),
  );
  const nvram = toolContract("inspect_uefi_nvram");
  server.registerTool(
    nvram.name,
    toolRegistrationOptions(nvram),
    handler(nvram),
  );
};
