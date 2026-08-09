import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
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
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import type { ProgressReporter } from "../application/ProgressReporter.js";
import { BROWSER_TOOL_CONTRACTS } from "../contracts/browserToolContracts.js";
import type { ToolContract } from "../contracts/toolContracts.js";
import type { AnalysisError } from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import type { Result } from "../domain/result.js";
import type { Logger } from "../logger.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

interface BrowserToolRegistration {
  readonly logger: Logger;
  readonly browser: BrowserObservationPort | undefined;
  readonly permissionAuthority: PermissionAuthority | undefined;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
}

interface BrowserToolContext {
  readonly signal: AbortSignal;
  readonly progress: ProgressReporter;
}

/** Register browser tools even when policy/provider availability denies execution. */
// oxlint-disable-next-line max-lines-per-function -- direct SDK calls retain each schema-handler type correlation.
export const registerBrowserTools = (
  server: McpServer,
  options: BrowserToolRegistration,
): void => {
  const [
    listContract,
    inspectContract,
    analyzeContract,
    sessionContract,
    webMcpContract,
    captureDiffContract,
    screenshotContract,
    screenshotDiffContract,
  ] = BROWSER_TOOL_CONTRACTS;

  server.registerTool(
    listContract.name,
    toolRegistrationOptions(listContract),
    (input, context) =>
      runBrowserTool(
        options,
        listContract,
        { input, context },
        (parsed, { signal }) =>
          listBrowserTargets(
            options.browser,
            options.permissionAuthority,
            parsed,
            {
              signal,
            },
          ),
      ),
  );
  server.registerTool(
    inspectContract.name,
    toolRegistrationOptions(inspectContract),
    (input, context) =>
      runBrowserTool(
        options,
        inspectContract,
        { input, context },
        (parsed, { signal, progress }) =>
          inspectWebPage(options.browser, options.permissionAuthority, parsed, {
            signal,
            progress,
          }),
      ),
  );
  server.registerTool(
    analyzeContract.name,
    toolRegistrationOptions(analyzeContract),
    (input, context) =>
      runBrowserTool(
        options,
        analyzeContract,
        { input, context },
        (parsed, { signal, progress }) =>
          analyzeWebBundle(
            options.browser,
            options.permissionAuthority,
            parsed,
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
        options,
        sessionContract,
        { input, context },
        (parsed, { signal, progress }) =>
          observeWebSession(
            options.browser,
            options.permissionAuthority,
            parsed,
            {
              signal,
              progress,
            },
          ),
      ),
  );
  server.registerTool(
    webMcpContract.name,
    toolRegistrationOptions(webMcpContract),
    (input, context) =>
      runBrowserTool(
        options,
        webMcpContract,
        { input, context },
        (parsed, { signal, progress }) =>
          discoverWebMcpTools(
            options.browser,
            options.permissionAuthority,
            parsed,
            {
              signal,
              progress,
            },
          ),
      ),
  );
  server.registerTool(
    captureDiffContract.name,
    toolRegistrationOptions(captureDiffContract),
    (input, context) =>
      runBrowserTool(
        options,
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
        options,
        screenshotContract,
        { input, context },
        (parsed, { signal, progress }) =>
          captureWebScreenshot(
            options.browser,
            options.permissionAuthority,
            parsed,
            {
              signal,
              progress,
            },
          ),
      ),
  );
  server.registerTool(
    screenshotDiffContract.name,
    toolRegistrationOptions(screenshotDiffContract),
    (input, context) =>
      runBrowserTool(
        options,
        screenshotDiffContract,
        { input, context },
        (parsed) => compareWebScreenshotEvidence(options.browser, parsed),
      ),
  );
};

const runBrowserTool = async <Input>(
  options: BrowserToolRegistration,
  contract: ToolContract,
  request: { readonly input: Input; readonly context: ServerContext },
  execute: (
    input: Input,
    context: BrowserToolContext,
  ) => Promise<Result<Evidence, AnalysisError>>,
) => {
  const { input, context } = request;
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
  options: BrowserToolRegistration,
  contract: ToolContract,
  evidence: Evidence,
) => {
  const recorded = options.recordEvidence?.(evidence);
  return recorded !== undefined && !recorded.ok
    ? toCallToolResult(recorded, contract)
    : toCallToolResult({ ok: true, value: evidence }, contract, {
        evidenceResourcesAvailable: recorded !== undefined,
      });
};
