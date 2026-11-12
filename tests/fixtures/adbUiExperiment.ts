import type { AdbDeviceAnalysisPort } from "../../src/application/adb/AdbDeviceAnalysisPort.js";
import { AdbDeviceAnalysisService } from "../../src/application/adb/AdbDeviceAnalysisService.js";
import type { BinarySession } from "../../src/application/binary/BinarySession.js";
import { PROPOSED_ADB_UI_ACTION_CONTRACT } from "../../src/contracts/adb/adbUiToolContracts.js";
import { createLogger } from "../../src/logger.js";
import { createContractToolHandler } from "../../src/server/contractToolHandler.js";
import type { EvidenceMcpServer } from "../../src/server/EvidenceMcpServer.js";
import { toolRegistrationOptions } from "../../src/server/toolRegistrationOptions.js";

/** Explicit test-only binding, never part of normal server composition. */
export const registerAdbUiExperiment = (
  server: EvidenceMcpServer,
  provider: AdbDeviceAnalysisPort,
  session: BinarySession,
): void => {
  const contract = PROPOSED_ADB_UI_ACTION_CONTRACT;
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    createContractToolHandler(
      server,
      new AdbDeviceAnalysisService(provider),
      createLogger("mcp", "silent"),
      (evidence) => session.recordEvidence(evidence),
    )(contract),
  );
};
