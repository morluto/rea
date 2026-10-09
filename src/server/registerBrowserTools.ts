import type { ToolResultDelivery } from "./toolResult.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import {
  optionalProviderUnavailable,
  type OptionalProviderLoadFailure,
} from "../application/OptionalObservationProviders.js";
import { err } from "../domain/result.js";
import type { ServerContext } from "@modelcontextprotocol/server";

import type { BrowserObservationPort } from "../application/BrowserObservationPort.js";
import {
  analyzeWebBundle,
  captureWebScreenshot,
  compareWebCaptureEvidence,
  compareWebScreenshotEvidence,
  discoverWebMcpTools,
  inspectWebPage,
  listBrowserTargets,
  observeWebSession,
} from "../application/BrowserObservationService.js";
import type { ProgressReporter } from "../application/ProgressReporter.js";
import { toolContract, type ToolContract } from "../contracts/toolContracts.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import { analyzeWebBundleInputSchema } from "../domain/webBundleAnalysis.js";
import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import type { Result } from "../domain/result.js";
import type { Logger } from "../logger.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

interface BrowserToolRegistration {
  readonly logger: Logger;
  readonly loadFailure?: OptionalProviderLoadFailure | undefined;
  readonly browser: BrowserObservationPort | undefined;
  readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
}

interface BrowserToolContext {
  readonly signal: AbortSignal;
  readonly progress: ProgressReporter;
}

/** Register browser tools with execution-time provider diagnostics. */
// oxlint-disable-next-line max-lines-per-function -- direct SDK calls retain each schema-handler type correlation.
export const registerBrowserTools = (
  server: EvidenceMcpServer,
  options: BrowserToolRegistration,
): void => {
  const registration = { ...options, delivery: server.delivery };
  const listContract = toolContract("list_browser_targets");
  const inspectContract = toolContract("inspect_web_page");
  const analyzeContract = toolContract("analyze_web_bundle");
  const sessionContract = toolContract("observe_web_session");
  const webMcpContract = toolContract("discover_webmcp_tools");
  const captureDiffContract = toolContract("compare_web_captures");
  const screenshotContract = toolContract("capture_web_screenshot");
  const screenshotDiffContract = toolContract("compare_web_screenshots");

  server.registerTool(
    listContract.name,
    toolRegistrationOptions(listContract),
    (input, context) =>
      runBrowserTool(
        registration,
        listContract,
        { input, context },
        (parsed, { signal }) =>
          listBrowserTargets(options.browser, parsed, {
            signal,
          }),
      ),
  );
  server.registerTool(
    inspectContract.name,
    toolRegistrationOptions(inspectContract),
    (input, context) =>
      runBrowserTool(
        registration,
        inspectContract,
        { input, context },
        (parsed, { signal, progress }) =>
          inspectWebPage(
            options.browser,
            inspectWebPageInputSchema.parse(parsed),
            { signal, progress },
          ),
      ),
  );
  server.registerTool(
    analyzeContract.name,
    toolRegistrationOptions(analyzeContract),
    (input, context) =>
      runBrowserTool(
        registration,
        analyzeContract,
        { input, context },
        (parsed, { signal, progress }) =>
          analyzeWebBundle(
            options.browser,
            analyzeWebBundleInputSchema.parse(parsed),
            {
              signal,
              progress,
            },
          ),
      ),
  );
  server.registerTool(
    sessionContract.name,
    toolRegistrationOptions(sessionContract),
    (input, context) =>
      runBrowserTool(
        registration,
        sessionContract,
        { input, context },
        (parsed, { signal, progress }) =>
          observeWebSession(options.browser, parsed, {
            signal,
            progress,
          }),
      ),
  );
  server.registerTool(
    webMcpContract.name,
    toolRegistrationOptions(webMcpContract),
    (input, context) =>
      runBrowserTool(
        registration,
        webMcpContract,
        { input, context },
        (parsed, { signal, progress }) =>
          discoverWebMcpTools(options.browser, parsed, {
            signal,
            progress,
          }),
      ),
  );
  server.registerTool(
    captureDiffContract.name,
    toolRegistrationOptions(captureDiffContract),
    (input, context) =>
      runBrowserTool(
        registration,
        captureDiffContract,
        { input, context },
        (parsed) => compareWebCaptureEvidence(options.browser, parsed),
      ),
  );
  server.registerTool(
    screenshotContract.name,
    toolRegistrationOptions(screenshotContract),
    (input, context) =>
      runBrowserTool(
        registration,
        screenshotContract,
        { input, context },
        (parsed, { signal, progress }) =>
          captureWebScreenshot(options.browser, parsed, {
            signal,
            progress,
          }),
      ),
  );
  server.registerTool(
    screenshotDiffContract.name,
    toolRegistrationOptions(screenshotDiffContract),
    (input, context) =>
      runBrowserTool(
        registration,
        screenshotDiffContract,
        { input, context },
        (parsed) => compareWebScreenshotEvidence(options.browser, parsed),
      ),
  );
};

const runBrowserTool = async <Input>(
  options: BrowserToolRegistration & { readonly delivery: ToolResultDelivery },
  contract: ToolContract,
  request: { readonly input: Input; readonly context: ServerContext },
  execute: (
    input: Input,
    context: BrowserToolContext,
  ) => Promise<Result<Evidence, AnalysisError>>,
) => {
  const { input, context } = request;
  if (options.loadFailure !== undefined)
    return options.delivery.toCallToolResult(
      err(optionalProviderUnavailable(options.loadFailure, contract.name)),
      contract,
    );
  const result = await logToolExecution(options.logger, contract.name, () =>
    execute(input, {
      signal: context.mcpReq.signal,
      progress: mcpProgressReporter(context),
    }),
  );
  if (!result.ok) return options.delivery.toCallToolResult(result, contract);
  return evidenceResult(options, contract, result.value);
};

const evidenceResult = (
  options: BrowserToolRegistration & { readonly delivery: ToolResultDelivery },
  contract: ToolContract,
  evidence: Evidence,
) => {
  const recorded = options.recordEvidence?.(evidence);
  return options.delivery.toEvidenceToolResult(evidence, contract, recorded);
};
