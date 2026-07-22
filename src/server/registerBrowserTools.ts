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
import {
  registerObservationTool,
  type ObservationToolRegistration,
} from "./observationToolRegistration.js";

interface BrowserToolRegistration {
  readonly logger: ObservationToolRegistration["logger"];
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

  registerObservationTool(server, options, {
    contract: listContract,
    schema: listBrowserTargetsInputSchema,
    execute: (parsed, { signal }) =>
      listBrowserTargets(options.browser, options.permissionAuthority, parsed, {
        signal,
      }),
  });
  registerObservationTool(server, options, {
    contract: inspectContract,
    schema: inspectWebPageInputSchema,
    execute: (parsed, { signal, progress }) =>
      inspectWebPage(options.browser, options.permissionAuthority, parsed, {
        signal,
        progress,
      }),
  });
  registerObservationTool(server, options, {
    contract: analyzeContract,
    schema: analyzeWebBundleInputSchema,
    execute: (parsed, { signal, progress }) =>
      analyzeWebBundle(options.browser, options.permissionAuthority, parsed, {
        signal,
        progress,
      }),
  });
  registerObservationTool(server, options, {
    contract: sessionContract,
    schema: observeWebSessionInputSchema,
    execute: (parsed, { signal, progress }) =>
      observeWebSession(options.browser, options.permissionAuthority, parsed, {
        signal,
        progress,
      }),
  });
  registerObservationTool(server, options, {
    contract: webMcpContract,
    schema: discoverWebMcpToolsInputSchema,
    execute: (parsed, { signal, progress }) =>
      discoverWebMcpTools(
        options.browser,
        options.permissionAuthority,
        parsed,
        {
          signal,
          progress,
        },
      ),
  });
  registerObservationTool(server, options, {
    contract: captureDiffContract,
    schema: compareWebCapturesInputSchema,
    execute: (parsed) => compareWebCaptureEvidence(options.browser, parsed),
  });
  registerObservationTool(server, options, {
    contract: screenshotContract,
    schema: captureWebScreenshotInputSchema,
    execute: (parsed, { signal, progress }) =>
      captureWebScreenshot(
        options.browser,
        options.permissionAuthority,
        parsed,
        {
          signal,
          progress,
        },
      ),
  });
  registerObservationTool(server, options, {
    contract: screenshotDiffContract,
    schema: compareWebScreenshotsInputSchema,
    execute: (parsed) => compareWebScreenshotEvidence(options.browser, parsed),
  });
};
