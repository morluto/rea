import { Cli, z } from "incur";

import { browserContext, browserCliError } from "../cliBrowserContext.js";
import { browserScopeOptions } from "../cliObservationOptions.js";
import {
  captureWebScreenshot,
  compareWebCaptureEvidence,
  compareWebScreenshotEvidence,
  discoverWebMcpTools,
} from "../application/BrowserObservationService.js";
import { CdpBrowserProvider } from "../browser/CdpBrowserProvider.js";
import { logCliCommand } from "../cliLogging.js";
import {
  AnalysisInputError,
  type AnalysisInputIssue,
} from "../domain/analysisErrorCore.js";
import { browserCaptureComparisonInputSchema } from "../domain/browserCaptureComparison.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { discoverWebMcpToolsInputSchema } from "../domain/webMcpDiscovery.js";
import {
  captureWebScreenshotInputSchema,
  compareWebScreenshotsInputSchema,
} from "../domain/webScreenshot.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import type { Logger } from "pino";
import { CLI_COMMANDS } from "../cliCommandNames.js";

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
      beforeJson: z
        .string()
        .describe("Earlier normalized web capture JSON or JSON file path"),
      afterJson: z
        .string()
        .describe("Later normalized web capture JSON or JSON file path"),
    }),
    options: z.object({
      normalizationJson: z
        .string()
        .default('{"rules":[]}')
        .describe(
          "Recorded literal normalization policy JSON or JSON file path for browser scenarios",
        ),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "compare-web-captures", async () => {
        const inputs = await parseJsonArguments("compare_web_captures", {
          before: args.beforeJson,
          after: args.afterJson,
          normalization: options.normalizationJson,
        });
        if (!inputs.ok) return inputs.error;
        const { before, after, normalization } = inputs.value;
        const scenarioComparison =
          browserCaptureComparisonInputSchema.safeParse({
            before_scenario: before,
            after_scenario: after,
            normalization,
          });
        const parsed = scenarioComparison.success
          ? scenarioComparison
          : browserCaptureComparisonInputSchema.safeParse({ before, after });
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
      beforeJson: z
        .string()
        .describe("Earlier screenshot artifact JSON or JSON file path"),
      afterJson: z
        .string()
        .describe("Later screenshot artifact JSON or JSON file path"),
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
        const operation = "compare_web_screenshots";
        const inputs = await parseJsonArguments(operation, {
          before: args.beforeJson,
          after: args.afterJson,
        });
        if (!inputs.ok) return inputs.error;
        const { before, after } = inputs.value;
        const input = {
          before,
          after,
          channel_threshold: options.channelThreshold,
        };
        const parsed = compareWebScreenshotsInputSchema.safeParse(input);
        if (!parsed.success)
          return browserCliError(
            new AnalysisInputError(
              operation,
              { cause: parsed.error },
              projectInputIssues(parsed.error.issues, input),
            ),
          );
        const result = await compareWebScreenshotEvidence(
          new CdpBrowserProvider(),
          parsed.data,
        );
        return result.ok ? result.value : browserCliError(result.error);
      }),
  });
};

/**
 * Parse each named inline JSON argument or local JSON file, like other
 * JSON-input commands. Screenshot artifacts and scenario captures embed PNG
 * bytes that can exceed the host's command-line length limit.
 */
const parseJsonArguments = async (
  operation: string,
  fields: Readonly<Record<string, string>>,
): Promise<
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: JsonValue }
> => {
  const values: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) {
    const parsed = await parseCliJsonInput(value, operation);
    if (!parsed.ok)
      return isFileInputFailure(parsed.error)
        ? parsed
        : {
            ok: false,
            error: inputError(operation, [invalidJsonIssue(field)]),
          };
    values[field] = parsed.value;
  }
  return { ok: true, value: values };
};

/** File read and decode failures name the selected path; inline JSON does not. */
const isFileInputFailure = (error: JsonValue): boolean =>
  typeof error === "object" &&
  error !== null &&
  !Array.isArray(error) &&
  "input_path" in error;

const invalidJsonIssue = (field: string): AnalysisInputIssue => ({
  path: [field],
  reason: "invalid_format",
  expected: "JSON",
});

const inputError = (
  operation: string,
  issues: readonly AnalysisInputIssue[] = [],
): JsonValue =>
  browserCliError(new AnalysisInputError(operation, undefined, issues));
