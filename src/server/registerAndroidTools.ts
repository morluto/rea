import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { AndroidAnalysisService } from "../application/android/AndroidAnalysisService.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createContractToolHandler } from "./contractToolHandler.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";

/** Bind Android handlers to their exact named contracts through shared workflows. */
export const registerAndroidTools = (
  server: EvidenceMcpServer,
  service: AndroidAnalysisService,
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
  const packageContract = toolContract("inspect_android_package");
  server.registerTool(
    packageContract.name,
    toolRegistrationOptions(packageContract),
    handler(packageContract),
  );
  const searchContract = toolContract("search_android_classes");
  server.registerTool(
    searchContract.name,
    toolRegistrationOptions(searchContract),
    handler(searchContract),
  );
  const classContract = toolContract("inspect_android_class");
  server.registerTool(
    classContract.name,
    toolRegistrationOptions(classContract),
    handler(classContract),
  );
  const methodContract = toolContract("inspect_android_method");
  server.registerTool(
    methodContract.name,
    toolRegistrationOptions(methodContract),
    handler(methodContract),
  );
  const referencesContract = toolContract("trace_android_references");
  server.registerTool(
    referencesContract.name,
    toolRegistrationOptions(referencesContract),
    handler(referencesContract),
  );
};
