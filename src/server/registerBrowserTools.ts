import type { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";

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
import { safeParseToolInput } from "./toolInputValidation.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import type { ProgressReporter } from "../application/ProgressReporter.js";
import type { Evidence } from "../domain/evidence.js";
import type { Result } from "../domain/result.js";
import type { AnalysisError } from "../domain/errors.js";
import type { ToolContract } from "../contracts/toolContracts.js";

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

interface BrowserToolSpec<Schema extends z.ZodType> {
  readonly contract: ToolContract;
  readonly schema: Schema;
  readonly execute: (
    parsed: z.output<Schema>,
    context: BrowserToolContext,
  ) => Promise<Result<Evidence, AnalysisError>>;
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

  registerBrowserTool(server, options, {
    contract: listContract,
    schema: listBrowserTargetsInputSchema,
    execute: (parsed, { signal }) =>
      listBrowserTargets(options.browser, options.permissionAuthority, parsed, {
        signal,
      }),
  });
  registerBrowserTool(server, options, {
    contract: inspectContract,
    schema: inspectWebPageInputSchema,
    execute: (parsed, { signal, progress }) =>
      inspectWebPage(options.browser, options.permissionAuthority, parsed, {
        signal,
        progress,
      }),
  });
  registerBrowserTool(server, options, {
    contract: analyzeContract,
    schema: analyzeWebBundleInputSchema,
    execute: (parsed, { signal, progress }) =>
      analyzeWebBundle(options.browser, options.permissionAuthority, parsed, {
        signal,
        progress,
      }),
  });
  registerBrowserTool(server, options, {
    contract: sessionContract,
    schema: observeWebSessionInputSchema,
    execute: (parsed, { signal, progress }) =>
      observeWebSession(options.browser, options.permissionAuthority, parsed, {
        signal,
        progress,
      }),
  });
  registerBrowserTool(server, options, {
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
  registerBrowserTool(server, options, {
    contract: captureDiffContract,
    schema: compareWebCapturesInputSchema,
    execute: (parsed, _context) =>
      compareWebCaptureEvidence(options.browser, parsed),
  });
  registerBrowserTool(server, options, {
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
  registerBrowserTool(server, options, {
    contract: screenshotDiffContract,
    schema: compareWebScreenshotsInputSchema,
    execute: (parsed, _context) =>
      compareWebScreenshotEvidence(options.browser, parsed),
  });
};

const registerBrowserTool = <Schema extends z.ZodType>(
  server: McpServer,
  options: BrowserToolRegistration,
  spec: BrowserToolSpec<Schema>,
): void => {
  server.registerTool(
    spec.contract.name,
    toolRegistrationOptions(spec.contract),
    async (input, context) => {
      const parsedInput = safeParseToolInput(
        spec.schema,
        input,
        spec.contract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, spec.contract);
      const result = await logToolExecution(
        options.logger,
        spec.contract.name,
        () =>
          spec.execute(parsedInput.value, {
            signal: context.mcpReq.signal,
            progress: mcpProgressReporter(context),
          }),
      );
      if (!result.ok) return toCallToolResult(result, spec.contract);
      return evidenceResult(options, spec.contract, result.value);
    },
  );
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
