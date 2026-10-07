import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import {
  optionalProviderUnavailable,
  type OptionalProviderLoadFailure,
} from "../application/OptionalObservationProviders.js";
import { err } from "../domain/result.js";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import type { ElectronActiveObservationPort } from "../application/javascript/ElectronActiveObservationPort.js";
import { captureElectronScenario } from "../application/javascript/ElectronActiveObservationService.js";
import type { ElectronObservationPort } from "../application/javascript/ElectronObservationPort.js";
import {
  inspectElectronPage,
  listElectronTargets,
} from "../application/javascript/ElectronObservationService.js";
import { analyzeJavaScriptApplicationValidated } from "../application/javascript/JavaScriptApplicationService.js";
import { reconcileJavaScriptRuntimeEvidenceValidated } from "../application/javascript/JavaScriptRuntimeReconciliationService.js";
import type { ProgressReporter } from "../application/ProgressReporter.js";
import { toolContract, type ToolContract } from "../contracts/toolContracts.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import type { Result } from "../domain/result.js";
import { inspectElectronPageInputSchema } from "../domain/javascript/electronObservation.js";
import type { Logger } from "../logger.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

interface ElectronToolRegistration {
  readonly logger: Logger;
  readonly observationLoadFailure?: OptionalProviderLoadFailure | undefined;
  readonly activeLoadFailure?: OptionalProviderLoadFailure | undefined;
  readonly electron: ElectronObservationPort | undefined;
  readonly electronActive: ElectronActiveObservationPort | undefined;
  readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
}

interface ElectronToolContext {
  readonly signal: AbortSignal;
  readonly progress: ProgressReporter;
}

/** Register Electron tools even when a provider is absent. */
// oxlint-disable-next-line max-lines-per-function -- direct SDK calls retain each schema-handler type correlation.
export const registerElectronTools = (
  server: McpServer,
  options: ElectronToolRegistration,
): void => {
  const listContract = toolContract("list_electron_targets");
  const inspectContract = toolContract("inspect_electron_page");
  const analyzeContract = toolContract("analyze_javascript_application");
  const reconcileContract = toolContract("reconcile_javascript_runtime");
  const activeContract = toolContract("capture_electron_scenario");

  server.registerTool(
    listContract.name,
    toolRegistrationOptions(listContract),
    (input, context) =>
      runElectronTool(
        options,
        listContract,
        { input, context },
        (parsed, { signal }) =>
          listElectronTargets(options.electron, parsed, {
            signal,
          }),
      ),
  );
  server.registerTool(
    inspectContract.name,
    toolRegistrationOptions(inspectContract),
    (input, context) =>
      runElectronTool(
        options,
        inspectContract,
        { input, context },
        async (parsed, { signal, progress }) => {
          const request = inspectElectronPageInputSchema.parse(parsed);
          return inspectElectronPage(options.electron, request, {
            signal,
            progress,
          });
        },
      ),
  );
  server.registerTool(
    analyzeContract.name,
    toolRegistrationOptions(analyzeContract),
    (input, context) =>
      runElectronTool(
        options,
        analyzeContract,
        { input, context },
        (parsed, { signal, progress }) =>
          analyzeJavaScriptApplicationValidated(parsed, { signal, progress }),
      ),
  );
  server.registerTool(
    reconcileContract.name,
    toolRegistrationOptions(reconcileContract),
    (input, context) =>
      runElectronTool(
        options,
        reconcileContract,
        { input, context },
        (parsed) =>
          Promise.resolve(reconcileJavaScriptRuntimeEvidenceValidated(parsed)),
      ),
  );
  server.registerTool(
    activeContract.name,
    toolRegistrationOptions(activeContract),
    (input, context) =>
      runElectronTool(
        options,
        activeContract,
        { input, context },
        (parsed, { signal, progress }) =>
          captureElectronScenario(options.electronActive, parsed, {
            signal,
            progress,
          }),
      ),
  );
};

const runElectronTool = async <Input>(
  options: ElectronToolRegistration,
  contract: ToolContract,
  request: {
    readonly input: Input;
    readonly context: ServerContext;
  },
  execute: (
    input: Input,
    context: ElectronToolContext,
  ) => Promise<Result<Evidence, AnalysisError>>,
) => {
  const { input, context } = request;
  const failure =
    contract.name === "capture_electron_scenario"
      ? options.activeLoadFailure
      : contract.name === "list_electron_targets" ||
          contract.name === "inspect_electron_page"
        ? options.observationLoadFailure
        : undefined;
  if (failure !== undefined)
    return toCallToolResult(
      err(optionalProviderUnavailable(failure, contract.name)),
      contract,
    );
  const result = await logToolExecution(options.logger, contract.name, () =>
    execute(input, {
      signal: context.mcpReq.signal,
      progress: mcpProgressReporter(context),
    }),
  );
  if (!result.ok) return toCallToolResult(result, contract);
  return evidenceResult(options, contract, result.value);
};

const evidenceResult = (
  options: ElectronToolRegistration,
  contract: ToolContract,
  evidence: Evidence,
) => {
  const recorded = options.recordEvidence?.(evidence);
  return recorded !== undefined && !recorded.ok
    ? toCallToolResult(recorded, contract)
    : toCallToolResult({ ok: true, value: evidence }, contract);
};
