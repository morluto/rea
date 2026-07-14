import type { McpServer } from "@modelcontextprotocol/server";

import type { BrowserObservationPort } from "../application/BrowserObservationPort.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import {
  inspectWebPage,
  listBrowserTargets,
} from "../application/BrowserObservationService.js";
import { BROWSER_TOOL_CONTRACTS } from "../contracts/browserToolContracts.js";
import {
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
} from "../domain/browserObservation.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toCallToolResult } from "./toolResult.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { mcpProgressReporter } from "./mcpProgress.js";

interface BrowserToolRegistration {
  readonly logger: Logger;
  readonly browser: BrowserObservationPort | undefined;
  readonly permissionAuthority: PermissionAuthority | undefined;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
}

/** Register browser tools even when policy/provider availability denies execution. */
export const registerBrowserTools = (
  server: McpServer,
  options: BrowserToolRegistration,
): void => {
  const [listContract, inspectContract] = BROWSER_TOOL_CONTRACTS;
  server.registerTool(
    listContract.name,
    toolRegistrationOptions(listContract),
    async (input, context) => {
      const parsed = listBrowserTargetsInputSchema.parse(input);
      const result = await logToolExecution(
        options.logger,
        listContract.name,
        () =>
          listBrowserTargets(
            options.browser,
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
      const parsed = inspectWebPageInputSchema.parse(input);
      const result = await logToolExecution(
        options.logger,
        inspectContract.name,
        () =>
          inspectWebPage(options.browser, options.permissionAuthority, parsed, {
            signal: context.mcpReq.signal,
            progress: mcpProgressReporter(context),
          }),
      );
      if (!result.ok) return toCallToolResult(result, inspectContract);
      return evidenceResult(options, inspectContract, result.value);
    },
  );
};

const evidenceResult = (
  options: BrowserToolRegistration,
  contract: (typeof BROWSER_TOOL_CONTRACTS)[number],
  evidence: import("../domain/evidence.js").Evidence,
) => {
  const recorded = options.recordEvidence?.(evidence);
  return recorded !== undefined && !recorded.ok
    ? toCallToolResult(recorded, contract)
    : toCallToolResult({ ok: true, value: evidence }, contract, {
        evidenceResourcesAvailable: recorded !== undefined,
      });
};
