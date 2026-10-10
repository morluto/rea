import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { WebNetworkCaptureService } from "../application/WebNetworkCaptureService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind historical inspection to its named contract and caller-owned Evidence writer. */
export const registerWebNetworkCaptureTool = (
  server: EvidenceMcpServer,
  service: WebNetworkCaptureService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("inspect_web_network_capture");
  const registration = toolRegistrationOptions(contract);
  // Keep the exact advertised contract; the shared service validates raw input
  // before effects so caller-declared sensitivity also covers invalid arguments.
  // SDK pre-validation otherwise emits unprojected issue paths as plain text.
  const inputSchema: StandardSchemaWithJSON = {
    "~standard": {
      ...registration.inputSchema["~standard"],
      vendor: "rea-application",
      validate: (value: unknown) => ({ value }),
    },
  };
  const handler = createEvidenceToolHandler(
    server,
    (input, options) => service.inspect(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    contract.name,
    { ...registration, inputSchema },
    handler(contract),
  );
};
