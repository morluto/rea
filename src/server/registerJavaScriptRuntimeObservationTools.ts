import type { ToolResultDelivery } from "./toolResult.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import {
  optionalProviderUnavailable,
  type OptionalProviderLoadFailure,
} from "../application/OptionalObservationProviders.js";
import { err } from "../domain/result.js";
import type { ServerContext } from "@modelcontextprotocol/server";

import type { JavaScriptRuntimeObservationPort } from "../application/javascript/JavaScriptRuntimeObservationPort.js";
import {
  listJavaScriptRuntimeTargets,
  observeJavaScriptRuntime,
} from "../application/javascript/JavaScriptRuntimeObservationService.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import type { Result } from "../domain/result.js";
import { observeJavaScriptRuntimeInputSchema } from "../domain/javascript/javascriptRuntimeObservation.js";
import type { Logger } from "pino";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { runAdmittedToolOperation } from "./admittedToolOperation.js";

interface RuntimeToolRegistration {
  readonly logger: Logger;
  readonly loadFailure?: OptionalProviderLoadFailure | undefined;
  readonly runtime: JavaScriptRuntimeObservationPort | undefined;
  readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
  readonly withAdmittedAnalysis?: WithAdmittedAnalysis;
}

/** Register passive Inspector tools even when policy keeps them unavailable. */
export const registerJavaScriptRuntimeObservationTools = (
  server: EvidenceMcpServer,
  options: RuntimeToolRegistration,
): void => {
  const registration = { ...options, delivery: server.delivery, server };
  const listContract = toolContract("list_javascript_runtime_targets");
  const observeContract = toolContract("observe_javascript_runtime");
  server.registerTool(
    listContract.name,
    toolRegistrationOptions(listContract),
    (input, context) =>
      runRuntimeTool(
        registration,
        listContract,
        { input, context },
        (parsed, signal) =>
          listJavaScriptRuntimeTargets(options.runtime, parsed, { signal }),
      ),
  );
  server.registerTool(
    observeContract.name,
    toolRegistrationOptions(observeContract),
    (input, context) =>
      runRuntimeTool(
        registration,
        observeContract,
        { input, context },
        async (parsed, signal) => {
          const request = observeJavaScriptRuntimeInputSchema.parse(parsed);
          return observeJavaScriptRuntime(options.runtime, request, { signal });
        },
      ),
  );
};

const runRuntimeTool = async <Input>(
  options: RuntimeToolRegistration & {
    readonly delivery: ToolResultDelivery;
    readonly server: EvidenceMcpServer;
  },
  contract: ToolContract,
  request: { readonly input: Input; readonly context: ServerContext },
  execute: (
    input: Input,
    signal: AbortSignal,
  ) => Promise<Result<Evidence, AnalysisError>>,
) => {
  const { input, context } = request;
  if (options.loadFailure !== undefined)
    return options.delivery.toCallToolResult(
      err(optionalProviderUnavailable(options.loadFailure, contract.name)),
      contract,
    );
  return runAdmittedToolOperation(
    options.server,
    options.withAdmittedAnalysis,
    contract.name,
    context.mcpReq.signal,
    async () => {
      const result = await logToolExecution(options.logger, contract.name, () =>
        execute(input, context.mcpReq.signal),
      );
      if (!result.ok)
        return options.delivery.toCallToolResult(result, contract);
      const recorded = options.recordEvidence?.(result.value);
      return options.delivery.toEvidenceToolResult(
        result.value,
        contract,
        recorded,
      );
    },
  );
};
