import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import {
  optionalProviderUnavailable,
  type OptionalProviderLoadFailure,
} from "../application/OptionalObservationProviders.js";
import { err } from "../domain/result.js";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import type { JavaScriptRuntimeObservationPort } from "../application/JavaScriptRuntimeObservationPort.js";
import {
  listJavaScriptRuntimeTargets,
  observeJavaScriptRuntime,
} from "../application/JavaScriptRuntimeObservationService.js";
import { toolContract, type ToolContract } from "../contracts/toolContracts.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import type { Result } from "../domain/result.js";
import { observeJavaScriptRuntimeInputSchema } from "../domain/javascriptRuntimeObservation.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

interface RuntimeToolRegistration {
  readonly logger: Logger;
  readonly loadFailure?: OptionalProviderLoadFailure | undefined;
  readonly runtime: JavaScriptRuntimeObservationPort | undefined;
  readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
}

/** Register passive Inspector tools even when policy keeps them unavailable. */
export const registerJavaScriptRuntimeObservationTools = (
  server: McpServer,
  options: RuntimeToolRegistration,
): void => {
  const listContract = toolContract("list_javascript_runtime_targets");
  const observeContract = toolContract("observe_javascript_runtime");
  server.registerTool(
    listContract.name,
    toolRegistrationOptions(listContract),
    (input, context) =>
      runRuntimeTool(
        options,
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
        options,
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
  options: RuntimeToolRegistration,
  contract: ToolContract,
  request: { readonly input: Input; readonly context: ServerContext },
  execute: (
    input: Input,
    signal: AbortSignal,
  ) => Promise<Result<Evidence, AnalysisError>>,
) => {
  const { input, context } = request;
  if (options.loadFailure !== undefined)
    return toCallToolResult(
      err(optionalProviderUnavailable(options.loadFailure, contract.name)),
      contract,
    );
  const result = await logToolExecution(options.logger, contract.name, () =>
    execute(input, context.mcpReq.signal),
  );
  if (!result.ok) return toCallToolResult(result, contract);
  const recorded = options.recordEvidence?.(result.value);
  return recorded !== undefined && !recorded.ok
    ? toCallToolResult(recorded, contract)
    : toCallToolResult({ ok: true, value: result.value }, contract);
};
