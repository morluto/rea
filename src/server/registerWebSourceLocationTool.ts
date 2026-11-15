import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { WebSourceLocationService } from "../application/WebSourceLocationService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { createRetainedSummaryToolHandler } from "./contractToolHandler.js";
import { applicationToolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind source point tracing to its exact named contract and session Evidence owner. */
export const registerWebSourceLocationTool = (
  server: EvidenceMcpServer,
  service: WebSourceLocationService,
  options: {
    readonly logger: Logger;
    readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
    readonly withAdmittedAnalysis: WithAdmittedAnalysis | undefined;
    readonly evidenceById: EvidenceLookup | undefined;
  },
): void => {
  const { logger, recordEvidence, withAdmittedAnalysis, evidenceById } =
    options;
  const contract = toolContract("trace_web_source_location");
  const handler = createRetainedSummaryToolHandler(
    server,
    contract,
    (input, options) => service.trace(input, options),
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
