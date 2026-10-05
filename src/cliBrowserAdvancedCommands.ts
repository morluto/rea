import { Cli, z } from "incur";

import { browserContext, browserCliError } from "./cliBrowserContext.js";
import { browserScopeOptions } from "./cliObservationOptions.js";
import {
  captureWebScreenshot,
  compareWebCaptureEvidence,
  compareWebScreenshotEvidence,
  discoverWebMcpTools,
} from "./application/BrowserObservationService.js";
import { CdpBrowserProvider } from "./browser/CdpBrowserProvider.js";
import { logCliCommand } from "./cliLogging.js";
import { AnalysisInputError } from "./domain/errors.js";
import { browserCaptureComparisonInputSchema } from "./domain/browserCaptureComparison.js";
import { discoverWebMcpToolsInputSchema } from "./domain/webMcpDiscovery.js";
import {
  captureWebScreenshotInputSchema,
  compareWebScreenshotsInputSchema,
} from "./domain/webScreenshot.js";
import type { JsonValue } from "./domain/jsonValue.js";
import { safeParseJson } from "./domain/safeJson.js";
import type { Logger } from "./logger.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";

/** Register WebMCP, capture-diff, and screenshot CLI equivalents. */
export const registerAdvancedBrowserCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  registerWebMcp(cli, logger);
  registerCaptureDiff(cli, logger);
  registerScreenshot(cli, logger);
  registerScreenshotDiff(cli, logger);
};

const registerWebMcp = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.discoverWebMcpTools, {
    description: "Passively discover page-declared WebMCP tools",
    args: z.object({
      endpoint: z.string().describe("Configured loopback CDP HTTP endpoint"),
      targetId: z.string().describe("Target ID from list-browser-targets"),
    }),
    options: z.object({
      ...browserScopeOptions,
      observationMs: z
        .number()
        .int()
        .min(0)
        .default(100)
        .describe("Observation duration in milliseconds"),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "discover-webmcp-tools", async () => {
        const context = browserContext();
        const parsed = discoverWebMcpToolsInputSchema.safeParse({
          cdp_endpoint: args.endpoint,
          allowed_origins: options.allowedOrigins,
          target_id: args.targetId,
          observation_ms: options.observationMs,
        });
        if (!parsed.success) return inputError("discover_webmcp_tools");
        const result = await discoverWebMcpTools(context.provider, parsed.data);
        return result.ok ? result.value : browserCliError(result.error);
      }),
  });
};

const registerCaptureDiff = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.compareWebCaptures, {
    description:
      "Compare two normalized passive captures or recorded browser scenarios",
    args: z.object({
      beforeJson: z.string().describe("Earlier normalized web capture JSON"),
      afterJson: z.string().describe("Later normalized web capture JSON"),
    }),
    options: z.object({
      normalizationJson: z
        .string()
        .default('{"rules":[]}')
        .describe(
          "Recorded literal normalization policy for browser scenarios",
        ),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "compare-web-captures", async () => {
        const before = parseJson(args.beforeJson);
        const after = parseJson(args.afterJson);
        const scenarioComparison =
          browserCaptureComparisonInputSchema.safeParse({
            before_scenario: before,
            after_scenario: after,
            normalization: parseJson(options.normalizationJson),
          });
        const parsed = scenarioComparison.success
          ? scenarioComparison
          : browserCaptureComparisonInputSchema.safeParse({
              before,
              after,
            });
        if (!parsed.success) return inputError("compare_web_captures");
        const result = await compareWebCaptureEvidence(
          new CdpBrowserProvider(),
          parsed.data,
        );
        return result.ok ? result.value : browserCliError(result.error);
      }),
  });
};

const registerScreenshot = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.captureWebScreenshot, {
    description:
      "Capture one visible page viewport within the supplied origin scope",
    args: z.object({
      endpoint: z.string().describe("Configured loopback CDP HTTP endpoint"),
      targetId: z.string().describe("Target ID from list-browser-targets"),
    }),
    options: z.object({
      ...browserScopeOptions,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "capture-web-screenshot", async () => {
        const context = browserContext();
        const parsed = captureWebScreenshotInputSchema.safeParse({
          cdp_endpoint: args.endpoint,
          allowed_origins: options.allowedOrigins,
          target_id: args.targetId,
        });
        if (!parsed.success) return inputError("capture_web_screenshot");
        const result = await captureWebScreenshot(
          context.provider,
          parsed.data,
        );
        return result.ok ? result.value : browserCliError(result.error);
      }),
  });
};

const registerScreenshotDiff = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.compareWebScreenshots, {
    description: "Compare two self-verifying PNG artifact JSON values",
    args: z.object({
      beforeJson: z.string().describe("Earlier screenshot artifact JSON"),
      afterJson: z.string().describe("Later screenshot artifact JSON"),
    }),
    options: z.object({
      channelThreshold: z
        .number()
        .int()
        .min(0)
        .max(255)
        .default(0)
        .describe("Per-channel difference threshold for changed pixels"),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "compare-web-screenshots", async () => {
        const parsed = compareWebScreenshotsInputSchema.safeParse({
          before: parseJson(args.beforeJson),
          after: parseJson(args.afterJson),
          channel_threshold: options.channelThreshold,
        });
        if (!parsed.success) return inputError("compare_web_screenshots");
        const result = await compareWebScreenshotEvidence(
          new CdpBrowserProvider(),
          parsed.data,
        );
        return result.ok ? result.value : browserCliError(result.error);
      }),
  });
};

const parseJson = (value: string): unknown => {
  const parsed = safeParseJson(value);
  return parsed.ok ? parsed.value : undefined;
};

const inputError = (operation: string): JsonValue =>
  browserCliError(new AnalysisInputError(operation));
