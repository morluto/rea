import type { AdbDeviceAnalysisPort } from "../../src/application/adb/AdbDeviceAnalysisPort.js";
import { AdbDeviceAnalysisService } from "../../src/application/adb/AdbDeviceAnalysisService.js";
import type { BinarySession } from "../../src/application/binary/BinarySession.js";
import { PROPOSED_ADB_UI_ACTION_CONTRACT } from "../../src/contracts/adb/adbUiToolContracts.js";
import { createLogger } from "../../src/logger.js";
import { createEvidenceToolHandler } from "../../src/server/contractToolHandler.js";
import type { EvidenceMcpServer } from "../../src/server/EvidenceMcpServer.js";
import { toolRegistrationOptions } from "../../src/server/toolRegistrationOptions.js";

/** Explicit test-only binding, never part of normal server composition. */
export const registerAdbUiExperiment = (
  server: EvidenceMcpServer,
  provider: AdbDeviceAnalysisPort,
  session: BinarySession,
): void => {
  const contract = PROPOSED_ADB_UI_ACTION_CONTRACT;
  const service = new AdbDeviceAnalysisService(provider);
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    createEvidenceToolHandler(
      server,
      (input, options) => service.execute(contract.name, input, options),
      createLogger("mcp", "silent"),
      (evidence) => session.recordEvidence(evidence),
    )(contract),
  );
};
