import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { AndroidAnalysisService } from "../application/android/AndroidAnalysisService.js";
import { inspectAndroidPackage } from "../application/android/AndroidPackageInspection.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import { summarizeRetainedAndroidSearch } from "../application/android/AndroidSearchEvidenceSummary.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import {
  createContractToolHandler,
  type ContractToolService,
} from "./contractToolHandler.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";

/** Bind Android handlers to their exact named contracts through shared workflows. */
export const registerAndroidTools = (
  server: EvidenceMcpServer,
  service: AndroidAnalysisService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
  evidenceById?: EvidenceLookup,
): void => {
  const handler = createContractToolHandler(
    server,
    service,
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  // Focused class searches keep complete raw inventory in the retained
  // record and deliver a bounded summary inline; the generic handler then
  // records and delivers the summary as the search contract's Evidence.
  const searchService: ContractToolService<"search_android_classes"> = {
    execute: async (operation, input, options) => {
      const executed = await service.execute(operation, input, options);
      if (!executed.ok) return executed;
      return summarizeRetainedAndroidSearch(executed.value, recordEvidence);
    },
  };
  const searchHandler = createContractToolHandler(
    server,
    searchService,
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  const packageContract = toolContract("inspect_android_package");
  const packageService: ContractToolService<"inspect_android_package"> = {
    execute: (_operation, input, options) =>
      inspectAndroidPackage(
        service,
        input,
        { recordEvidence, evidenceById },
        options,
      ),
  };
  const packageHandler = createContractToolHandler(
    server,
    packageService,
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    packageContract.name,
    toolRegistrationOptions(packageContract),
    packageHandler(packageContract),
  );
  const searchContract = toolContract("search_android_classes");
  server.registerTool(
    searchContract.name,
    toolRegistrationOptions(searchContract),
    searchHandler(searchContract),
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
