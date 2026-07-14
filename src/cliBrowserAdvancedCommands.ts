import { Cli, z } from "incur";

import {
  captureWebScreenshot,
  compareWebCaptureEvidence,
  compareWebScreenshotEvidence,
  discoverWebMcpTools,
} from "./application/BrowserObservationService.js";
import { loadConfiguredPermissionAuthority } from "./application/PermissionConfiguration.js";
import { CdpBrowserProvider } from "./browser/CdpBrowserProvider.js";
import { logCliCommand } from "./cliLogging.js";
import { parseConfig } from "./config.js";
import { AnalysisInputError, projectAnalysisError } from "./domain/errors.js";
import { compareWebCapturesInputSchema } from "./domain/webCaptureDiff.js";
import { discoverWebMcpToolsInputSchema } from "./domain/webMcpDiscovery.js";
import {
  captureWebScreenshotInputSchema,
  compareWebScreenshotsInputSchema,
} from "./domain/webScreenshot.js";
import type { JsonValue } from "./domain/jsonValue.js";
import type { Logger } from "./logger.js";

const scopeOptions = {
  allowedOrigins: z.array(z.string().min(1)).optional(),
  approved: z.boolean().default(false),
};

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
  cli.command("discover-webmcp-tools", {
    description: "Passively discover page-declared WebMCP tools",
    args: z.object({ endpoint: z.string(), targetId: z.string() }),
    options: z.object({
      ...scopeOptions,
      observationMs: z.number().int().min(0).max(10_000).default(100),
      maxTools: z.number().int().min(1).max(5_000).default(500),
      maxSchemaBytes: z
        .number()
        .int()
        .min(1)
        .max(1_024 * 1_024)
        .default(256 * 1_024),
      maxSchemaNodes: z.number().int().min(1).max(100_000).default(5_000),
      maxSchemaDepth: z.number().int().min(1).max(100).default(20),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "discover-webmcp-tools", async () => {
        const context = await browserContext();
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
        return result.ok ? result.value : cliError(result.error);
      }),
  });
};

const registerCaptureDiff = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command("compare-web-captures", {
    description: "Compare two normalized web capture JSON values",
    args: z.object({ beforeJson: z.string(), afterJson: z.string() }),
    options: z.object({
      maxChanges: z.number().int().min(1).max(20_000).default(2_000),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "compare-web-captures", async () => {
        const before = parseJson(args.beforeJson);
        const after = parseJson(args.afterJson);
        const parsed = compareWebCapturesInputSchema.safeParse({
          before,
          after,
          max_changes: options.maxChanges,
        });
        if (!parsed.success) return inputError("compare_web_captures");
        const result = await compareWebCaptureEvidence(
          new CdpBrowserProvider(),
          parsed.data,
        );
        return result.ok ? result.value : cliError(result.error);
      }),
  });
};

const registerScreenshot = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command("capture-web-screenshot", {
    description: "Capture an explicitly approved visible page viewport",
    args: z.object({ endpoint: z.string(), targetId: z.string() }),
    options: z.object({
      ...scopeOptions,
      screenshotApproved: z.boolean().default(false),
      maximumImageBytes: z
        .number()
        .int()
        .min(1)
        .max(8 * 1_024 * 1_024)
        .default(4 * 1_024 * 1_024),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "capture-web-screenshot", async () => {
        const context = await browserContext();
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
        return result.ok ? result.value : cliError(result.error);
      }),
  });
};

const registerScreenshotDiff = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command("compare-web-screenshots", {
    description: "Compare two self-verifying PNG artifact JSON values",
    args: z.object({ beforeJson: z.string(), afterJson: z.string() }),
    options: z.object({
      channelThreshold: z.number().int().min(0).max(255).default(0),
      maximumPixels: z
        .number()
        .int()
        .min(1)
        .max(32_000_000)
        .default(16_000_000),
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
        return result.ok ? result.value : cliError(result.error);
      }),
  });
};

const browserContext = async () => {
  const config = parseConfig(process.env);
  if (!config.ok) return { ok: false as const, error: cliError(config.error) };
  const authority = await loadConfiguredPermissionAuthority(config.value);
  if (!authority.ok)
    return { ok: false as const, error: cliError(authority.error) };
  return {
    ok: true as const,
    authority: authority.value,
    provider: new CdpBrowserProvider(),
    allowedBrowserOrigins: config.value.browserAllowedOrigins,
  };
};

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const inputError = (operation: string): JsonValue =>
  cliError(new AnalysisInputError(operation));

const cliError = (
  error: Parameters<typeof projectAnalysisError>[0],
): JsonValue => ({
  error: "Browser observation failed",
  ...projectAnalysisError(error),
});
