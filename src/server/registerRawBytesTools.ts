import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { RawBytesService } from "../application/binaryDiagnostics/RawBytesService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register the explicit-file raw byte read and search tools and retain their Evidence. */
export const registerRawBytesTools = (
  server: EvidenceMcpServer,
  service: RawBytesService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const handler = createEvidenceToolHandler(
    server,
    (input, options) => service.inspect(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  const searchHandler = createEvidenceToolHandler(
    server,
    (input, options) => service.search(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  const inspect = toolContract("inspect_raw_bytes");
  server.registerTool(
    inspect.name,
    toolRegistrationOptions(inspect),
    handler(inspect),
  );
  const search = toolContract("search_raw_bytes");
  server.registerTool(
    search.name,
    toolRegistrationOptions(search),
    searchHandler(search),
  );
};
