import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import {
  optionalProviderUnavailable,
  type OptionalProviderLoadFailure,
} from "../application/OptionalObservationProviders.js";
import { err } from "../domain/result.js";
import type { McpServer } from "@modelcontextprotocol/server";

import type { BrowserScenarioCapturePort } from "../application/BrowserScenarioCapturePort.js";
import { captureBrowserScenario } from "../application/BrowserScenarioCaptureService.js";
import { BROWSER_SCENARIO_TOOL_CONTRACTS } from "../contracts/browserScenarioToolContracts.js";
import { browserScenarioSchema } from "../domain/browserScenario.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

interface BrowserScenarioToolRegistration {
  readonly logger: Logger;
  readonly loadFailure?: OptionalProviderLoadFailure | undefined;
  readonly provider: BrowserScenarioCapturePort | undefined;
  readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
}

/** Register the browser scenario tool with execution-time provider diagnostics. */
export const registerBrowserScenarioTool = (
  server: McpServer,
  options: BrowserScenarioToolRegistration,
): void => {
  const [contract] = BROWSER_SCENARIO_TOOL_CONTRACTS;
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const scenario = browserScenarioSchema.parse(input);
      if (options.loadFailure !== undefined)
        return toCallToolResult(
          err(optionalProviderUnavailable(options.loadFailure, contract.name)),
          contract,
        );
      const result = await logToolExecution(options.logger, contract.name, () =>
        captureBrowserScenario(options.provider, scenario, {
          signal: context.mcpReq.signal,
        }),
      );
      if (!result.ok) return toCallToolResult(result, contract);
      const recorded = options.recordEvidence?.(result.value);
      return recorded !== undefined && !recorded.ok
        ? toCallToolResult(recorded, contract)
        : toCallToolResult({ ok: true, value: result.value }, contract);
    },
  );
};
