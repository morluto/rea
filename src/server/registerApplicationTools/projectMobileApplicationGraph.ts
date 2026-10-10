import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";

import { projectAndroidApplicationEvidence } from "../../application/android/AndroidApplicationService.js";
import { projectAppleApplicationEvidence } from "../../application/apple/AppleApplicationService.js";
import { projectHarmonyApplicationEvidence } from "../../application/harmony/HarmonyApplicationService.js";
import {
  APPLICATION_TOOL_CONTRACTS,
  applicationToolContract,
} from "../../contracts/applicationToolContracts.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import type { Result } from "../../domain/result.js";
import { recordSessionEvidenceSources } from "../sessionEvidence.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { recordResult } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

/** Register execution-free mobile application inventory projection tools. */
export const registerProjectMobileApplicationGraphTools = (
  server: EvidenceMcpServer,
  options: ApplicationToolRegistration,
): void => {
  registerProjection({
    server,
    options,
    contract: applicationToolContract("project_android_application_graph"),
    project: projectAndroidApplicationEvidence,
  });
  registerProjection({
    server,
    options,
    contract: applicationToolContract("project_apple_application_graph"),
    project: projectAppleApplicationEvidence,
  });
  registerProjection({
    server,
    options,
    contract: applicationToolContract("project_harmony_application_graph"),
    project: projectHarmonyApplicationEvidence,
  });
};

const registerProjection = (context: {
  readonly server: EvidenceMcpServer;
  readonly options: ApplicationToolRegistration;
  readonly contract: (typeof APPLICATION_TOOL_CONTRACTS)[number];
  readonly project: (input: unknown) => Result<Evidence, AnalysisError>;
}): void => {
  const { server, options, contract, project } = context;
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input: unknown) => {
      const result = await logToolExecution(options.logger, contract.name, () =>
        Promise.resolve(project(input)),
      );
      if (!result.ok) return server.delivery.toCallToolResult(result, contract);
      const recordedSources = recordSessionEvidenceSources(
        options.recordEvidence,
        inventoryEvidenceSources(input),
      );
      if (!recordedSources.ok)
        return server.delivery.toCallToolResult(recordedSources, contract);
      return recordResult(
        { ...options, delivery: server.delivery },
        contract,
        result.value,
      );
    },
  );
};

const inventoryEvidenceSources = (input: unknown): readonly Evidence[] => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("inventory_evidence" in input) ||
    !Array.isArray(input.inventory_evidence)
  )
    return [];
  return input.inventory_evidence as readonly Evidence[];
};
