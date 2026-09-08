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
        .max(10_000)
        .default(100)
        .describe("Observation duration in milliseconds"),
      maxTools: z
        .number()
        .int()
        .min(1)
        .max(5_000)
        .default(500)
        .describe("Maximum page-declared WebMCP tools to return"),
      maxSchemaBytes: z
        .number()
        .int()
        .min(1)
        .max(1_024 * 1_024)
        .default(256 * 1_024)
        .describe("Maximum serialized size of one declared tool schema"),
      maxSchemaNodes: z
        .number()
        .int()
        .min(1)
        .max(100_000)
        .default(5_000)
        .describe("Maximum nodes in one declared tool schema"),
      maxSchemaDepth: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum nesting depth in one declared tool schema"),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "discover-webmcp-tools", async () => {
        const context = await browserContext("discover_webmcp_tools");
        if (!context.ok) return context.error;
        const parsed = discoverWebMcpToolsInputSchema.safeParse({
          cdp_endpoint: args.endpoint,
          allowed_origins:
            options.allowedOrigins ?? context.allowedBrowserOrigins,
          target_id: args.targetId,
          approved: options.approved,
          observation_ms: options.observationMs,
          max_tools: options.maxTools,
          max_schema_bytes: options.maxSchemaBytes,
          max_schema_nodes: options.maxSchemaNodes,
          max_schema_depth: options.maxSchemaDepth,
        });
        if (!parsed.success) return inputError("discover_webmcp_tools");
        const result = await discoverWebMcpTools(
          context.provider,
          context.authority,
          parsed.data,
        );
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
      maxChanges: z
        .number()
        .int()
        .min(1)
        .max(20_000)
        .default(2_000)
        .describe("Maximum normalized changes to return"),
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
            max_changes: options.maxChanges,
          });
        const parsed = scenarioComparison.success
          ? scenarioComparison
          : browserCaptureComparisonInputSchema.safeParse({
              before,
              after,
              max_changes: options.maxChanges,
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
    description: "Capture an explicitly approved visible page viewport",
    args: z.object({
      endpoint: z.string().describe("Configured loopback CDP HTTP endpoint"),
      targetId: z.string().describe("Target ID from list-browser-targets"),
    }),
    options: z.object({
      ...browserScopeOptions,
      screenshotApproved: z
        .boolean()
        .default(false)
        .describe("Approve capturing the visible page viewport"),
      maximumImageBytes: z
        .number()
        .int()
        .min(1)
        .max(8 * 1_024 * 1_024)
        .default(4 * 1_024 * 1_024)
        .describe("Maximum captured PNG size"),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "capture-web-screenshot", async () => {
        const context = await browserContext("capture_web_screenshot");
        if (!context.ok) return context.error;
        const parsed = captureWebScreenshotInputSchema.safeParse({
          cdp_endpoint: args.endpoint,
          allowed_origins:
            options.allowedOrigins ?? context.allowedBrowserOrigins,
          target_id: args.targetId,
          approved: options.approved,
          screenshot_approved: options.screenshotApproved,
          maximum_image_bytes: options.maximumImageBytes,
        });
        if (!parsed.success) return inputError("capture_web_screenshot");
        const result = await captureWebScreenshot(
          context.provider,
          context.authority,
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
      maximumPixels: z
        .number()
        .int()
        .min(1)
        .max(32_000_000)
        .default(16_000_000)
        .describe("Maximum decoded pixels per screenshot"),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "compare-web-screenshots", async () => {
        const parsed = compareWebScreenshotsInputSchema.safeParse({
          before: parseJson(args.beforeJson),
          after: parseJson(args.afterJson),
          channel_threshold: options.channelThreshold,
          maximum_pixels: options.maximumPixels,
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
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const inputError = (operation: string): JsonValue =>
  browserCliError(new AnalysisInputError(operation));
