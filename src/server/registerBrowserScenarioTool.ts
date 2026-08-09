import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import type { BrowserScenarioCapturePort } from "../application/BrowserScenarioCapturePort.js";
import { captureBrowserScenario } from "../application/BrowserScenarioCaptureService.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import { BROWSER_SCENARIO_TOOL_CONTRACTS } from "../contracts/browserScenarioToolContracts.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

interface BrowserScenarioToolRegistration {
  readonly logger: Logger;
  readonly provider: BrowserScenarioCapturePort | undefined;
  readonly permissionAuthority: PermissionAuthority | undefined;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
}

/** Register the controlled browser scenario tool even when policy disables it. */
export const registerBrowserScenarioTool = (
  server: McpServer,
  options: BrowserScenarioToolRegistration,
): void => {
  const [contract] = BROWSER_SCENARIO_TOOL_CONTRACTS;
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const result = await logToolExecution(options.logger, contract.name, () =>
        captureBrowserScenario(
          options.provider,
          options.permissionAuthority,
          input,
          { signal: context.mcpReq.signal },
        ),
      );
      if (!result.ok) return toCallToolResult(result, contract);
      const recorded = options.recordEvidence?.(result.value);
      return recorded !== undefined && !recorded.ok
        ? toCallToolResult(recorded, contract)
        : toCallToolResult({ ok: true, value: result.value }, contract, {
            evidenceResourcesAvailable: recorded !== undefined,
          });
    },
  );
};
