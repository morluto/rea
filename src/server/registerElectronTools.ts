import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import type { ElectronObservationPort } from "../application/ElectronObservationPort.js";
import {
  inspectElectronPage,
  listElectronTargets,
} from "../application/ElectronObservationService.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import { ELECTRON_TOOL_CONTRACTS } from "../contracts/electronToolContracts.js";
import {
  inspectElectronPageInputSchema,
  listElectronTargetsInputSchema,
} from "../domain/electronObservation.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toCallToolResult } from "./toolResult.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { mcpProgressReporter } from "./mcpProgress.js";

interface ElectronToolRegistration {
  readonly logger: Logger;
  readonly electron: ElectronObservationPort | undefined;
  readonly permissionAuthority: PermissionAuthority | undefined;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
}

/** Register Electron tools even when provider or permission policy is absent. */
export const registerElectronTools = (
  server: McpServer,
  options: ElectronToolRegistration,
): void => {
  const [listContract, inspectContract] = ELECTRON_TOOL_CONTRACTS;
  server.registerTool(
    listContract.name,
    toolRegistrationOptions(listContract),
    async (input, context) => {
      const parsed = listElectronTargetsInputSchema.parse(input);
      const result = await logToolExecution(
        options.logger,
        listContract.name,
        () =>
          listElectronTargets(
            options.electron,
            options.permissionAuthority,
            parsed,
            { signal: context.mcpReq.signal },
          ),
      );
      if (!result.ok) return toCallToolResult(result, listContract);
      return evidenceResult(options, listContract, result.value);
    },
  );
  server.registerTool(
    inspectContract.name,
    toolRegistrationOptions(inspectContract),
    async (input, context) => {
      const parsed = inspectElectronPageInputSchema.parse(input);
      const result = await logToolExecution(
        options.logger,
        inspectContract.name,
        () =>
          inspectElectronPage(
            options.electron,
            options.permissionAuthority,
            parsed,
            {
              signal: context.mcpReq.signal,
              progress: mcpProgressReporter(context),
            },
          ),
      );
      if (!result.ok) return toCallToolResult(result, inspectContract);
      return evidenceResult(options, inspectContract, result.value);
    },
  );
};

const evidenceResult = (
  options: ElectronToolRegistration,
  contract: (typeof ELECTRON_TOOL_CONTRACTS)[number],
  evidence: import("../domain/evidence.js").Evidence,
) => {
  const recorded = options.recordEvidence?.(evidence);
  return recorded !== undefined && !recorded.ok
    ? toCallToolResult(recorded, contract)
    : toCallToolResult({ ok: true, value: evidence }, contract, {
        evidenceResourcesAvailable: recorded !== undefined,
      });
};
