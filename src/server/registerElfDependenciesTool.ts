import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { ElfDependenciesService } from "../application/binaryDiagnostics/ElfDependenciesService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createRetainedSummaryToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { applicationToolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";

/** Register the explicit-file ELF dependency workflow and retain its complete Evidence. */
export const registerElfDependenciesTool = (
  server: EvidenceMcpServer,
  service: ElfDependenciesService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  evidenceById?: EvidenceLookup,
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("inspect_elf_dependencies");
  const handler = createRetainedSummaryToolHandler(
    server,
    contract,
    (input, options) => service.inspect(input, options),
    logger,
    { recordEvidence, evidenceById },
    withAdmittedAnalysis,
  );
  server.registerTool(
    contract.name,
    applicationToolRegistrationOptions(contract),
    handler,
  );
};
