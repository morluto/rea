import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { ServerContext } from "@modelcontextprotocol/server";
import { AndroidAnalysisService } from "../application/android/AndroidAnalysisService.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { AndroidOperation } from "../domain/android/androidAnalysis.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind Android handlers to their exact named contracts through shared workflows. */
export const registerAndroidTools = (
  server: EvidenceMcpServer,
  service: AndroidAnalysisService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
): void => {
  const handler = (contract: ToolContract<AndroidOperation>) => {
    const name = contract.name;
    return async (input: unknown, context: ServerContext) => {
      const result = await logToolExecution(logger, name, () =>
        service.execute(name, input, { signal: context.mcpReq.signal }),
      );
      if (!result.ok) return server.delivery.toCallToolResult(result, contract);
      const recorded = recordEvidence?.(result.value);
      return server.delivery.toEvidenceToolResult(
        result.value,
        contract,
        recorded,
      );
    };
  };
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
