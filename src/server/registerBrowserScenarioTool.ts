import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import {
  optionalProviderUnavailable,
  type OptionalProviderLoadFailure,
} from "../application/OptionalObservationProviders.js";
import { err } from "../domain/result.js";

import type { BrowserScenarioCapturePort } from "../application/BrowserScenarioCapturePort.js";
import { captureBrowserScenario } from "../application/BrowserScenarioCaptureService.js";
import { toolContract } from "../contracts/toolContracts.js";
import { browserScenarioSchema } from "../domain/browserScenario.js";
import type { Logger } from "pino";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { runAdmittedToolOperation } from "./admittedToolOperation.js";

interface BrowserScenarioToolRegistration {
  readonly logger: Logger;
  readonly loadFailure?: OptionalProviderLoadFailure | undefined;
  readonly provider: BrowserScenarioCapturePort | undefined;
  readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
  readonly withAdmittedAnalysis?: WithAdmittedAnalysis;
}

/** Register the browser scenario tool with execution-time provider diagnostics. */
export const registerBrowserScenarioTool = (
  server: EvidenceMcpServer,
  options: BrowserScenarioToolRegistration,
): void => {
  const contract = toolContract("capture_browser_scenario");
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const scenario = browserScenarioSchema.parse(input);
      if (options.loadFailure !== undefined)
        return server.delivery.toCallToolResult(
          err(optionalProviderUnavailable(options.loadFailure, contract.name)),
          contract,
        );
      return runAdmittedToolOperation(
        server,
        options.withAdmittedAnalysis,
        contract.name,
        context.mcpReq.signal,
        async () => {
          const result = await logToolExecution(
            options.logger,
            contract.name,
            () =>
              captureBrowserScenario(options.provider, scenario, {
                signal: context.mcpReq.signal,
              }),
          );
          if (!result.ok)
            return server.delivery.toCallToolResult(result, contract);
          const recorded = options.recordEvidence?.(result.value);
          return server.delivery.toEvidenceToolResult(
            result.value,
            contract,
            recorded,
          );
        },
      );
    },
  );
};
