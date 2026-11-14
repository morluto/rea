import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { MavenGradleMetadataService } from "../application/java/MavenGradleMetadataService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register the explicit-file Maven POM / Gradle module metadata workflow and retain its complete Evidence. */
export const registerMavenGradleMetadataTool = (
  server: EvidenceMcpServer,
  service: MavenGradleMetadataService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("inspect_maven_gradle_metadata");
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
