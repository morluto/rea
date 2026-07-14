import type { McpServer } from "@modelcontextprotocol/server";

import type { BrowserObservationPort } from "../application/BrowserObservationPort.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
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
import { BROWSER_TOOL_CONTRACTS } from "../contracts/browserToolContracts.js";
import {
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
} from "../domain/browserObservation.js";
import { analyzeWebBundleInputSchema } from "../domain/webBundleAnalysis.js";
import { observeWebSessionInputSchema } from "../domain/browserSession.js";
import { discoverWebMcpToolsInputSchema } from "../domain/webMcpDiscovery.js";
import { compareWebCapturesInputSchema } from "../domain/webCaptureDiff.js";
import {
  captureWebScreenshotInputSchema,
  compareWebScreenshotsInputSchema,
} from "../domain/webScreenshot.js";
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
  server.registerTool(
    analyzeContract.name,
    toolRegistrationOptions(analyzeContract),
    async (input, context) => {
      const parsed = analyzeWebBundleInputSchema.parse(input);
      const result = await logToolExecution(
        options.logger,
        analyzeContract.name,
        () =>
          analyzeWebBundle(
            options.browser,
            options.permissionAuthority,
            parsed,
            {
              signal: context.mcpReq.signal,
              progress: mcpProgressReporter(context),
            },
          ),
      );
      if (!result.ok) return toCallToolResult(result, analyzeContract);
      return evidenceResult(options, analyzeContract, result.value);
    },
  );
  server.registerTool(
    sessionContract.name,
    toolRegistrationOptions(sessionContract),
    async (input, context) => {
      const parsed = observeWebSessionInputSchema.parse(input);
      const result = await logToolExecution(
        options.logger,
        sessionContract.name,
        () =>
          observeWebSession(
            options.browser,
            options.permissionAuthority,
            parsed,
            {
              signal: context.mcpReq.signal,
              progress: mcpProgressReporter(context),
            },
          ),
      );
      if (!result.ok) return toCallToolResult(result, sessionContract);
      return evidenceResult(options, sessionContract, result.value);
    },
  );
  server.registerTool(
    webMcpContract.name,
    toolRegistrationOptions(webMcpContract),
    async (input, context) => {
      const parsed = discoverWebMcpToolsInputSchema.parse(input);
      const result = await logToolExecution(
        options.logger,
        webMcpContract.name,
        () =>
          discoverWebMcpTools(
            options.browser,
            options.permissionAuthority,
            parsed,
            {
              signal: context.mcpReq.signal,
              progress: mcpProgressReporter(context),
            },
          ),
      );
      if (!result.ok) return toCallToolResult(result, webMcpContract);
      return evidenceResult(options, webMcpContract, result.value);
    },
  );
  server.registerTool(
    captureDiffContract.name,
    toolRegistrationOptions(captureDiffContract),
    async (input) => {
      const parsed = compareWebCapturesInputSchema.parse(input);
      const result = await logToolExecution(
        options.logger,
        captureDiffContract.name,
        () => compareWebCaptureEvidence(options.browser, parsed),
      );
      if (!result.ok) return toCallToolResult(result, captureDiffContract);
      return evidenceResult(options, captureDiffContract, result.value);
    },
  );
  server.registerTool(
    screenshotContract.name,
    toolRegistrationOptions(screenshotContract),
    async (input, context) => {
      const parsed = captureWebScreenshotInputSchema.parse(input);
      const result = await logToolExecution(
        options.logger,
        screenshotContract.name,
        () =>
          captureWebScreenshot(
            options.browser,
            options.permissionAuthority,
            parsed,
            {
              signal: context.mcpReq.signal,
              progress: mcpProgressReporter(context),
            },
          ),
      );
      if (!result.ok) return toCallToolResult(result, screenshotContract);
      return evidenceResult(options, screenshotContract, result.value);
    },
  );
  server.registerTool(
    screenshotDiffContract.name,
    toolRegistrationOptions(screenshotDiffContract),
    async (input) => {
      const parsed = compareWebScreenshotsInputSchema.parse(input);
      const result = await logToolExecution(
        options.logger,
        screenshotDiffContract.name,
        () => compareWebScreenshotEvidence(options.browser, parsed),
      );
      if (!result.ok) return toCallToolResult(result, screenshotDiffContract);
      return evidenceResult(options, screenshotDiffContract, result.value);
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
