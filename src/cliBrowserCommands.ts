import { Cli, z } from "incur";

import { browserContext, browserCliError } from "./cliBrowserContext.js";
import {
  analyzeWebBundle,
  inspectWebPage,
  listBrowserTargets,
  observeWebSession,
} from "./application/BrowserObservationService.js";
import { logCliCommand } from "./cliLogging.js";
import {
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
} from "./domain/browserObservation.js";
import { analyzeWebBundleInputSchema } from "./domain/webBundleAnalysis.js";
import { observeWebSessionInputSchema } from "./domain/browserSession.js";
import { AnalysisInputError } from "./domain/errors.js";
import type { Logger } from "./logger.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";
import {
  browserPageInspectionOptions,
  browserScopeOptions,
  observationDuration,
} from "./cliObservationOptions.js";

/** Register CLI equivalents of the passive browser MCP tools. */
export const registerBrowserCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  registerTargetList(cli, logger);
  registerPageInspection(cli, logger);
  registerBundleAnalysis(cli, logger);
  registerObservationSession(cli, logger);
};

const registerTargetList = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.listBrowserTargets, {
    description:
      "List page targets from a selected loopback CDP browser, optionally filtered by origin",
    args: z.object({
      endpoint: z.string().describe("Configured loopback CDP HTTP endpoint"),
    }),
    options: z.object({ ...browserScopeOptions }),
    run: ({ args, options }) =>
      logCliCommand(logger, "list-browser-targets", async () => {
        const context = browserContext();
        const parsed = listBrowserTargetsInputSchema.safeParse({
          cdp_endpoint: args.endpoint,
          allowed_origins: options.allowedOrigins,
        });
        if (!parsed.success)
          return browserCliError(
            new AnalysisInputError("list_browser_targets"),
          );
        const result = await listBrowserTargets(context.provider, parsed.data);
        return result.ok ? result.value : browserCliError(result.error);
      }),
  });
};

const registerPageInspection = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectWebPage, {
    description:
      "Passively inspect one page through CDP, defaulting to its current origin",
    args: z.object({
      endpoint: z.string().describe("Configured loopback CDP HTTP endpoint"),
      targetId: z.string().describe("Target ID from list-browser-targets"),
    }),
    options: browserPageInspectionOptions,
    run: ({ args, options }) =>
      logCliCommand(logger, "inspect-web-page", async () => {
        const context = browserContext();
        const parsed = inspectWebPageInputSchema.safeParse({
          cdp_endpoint: args.endpoint,
          allowed_origins: options.allowedOrigins,
          target_id: args.targetId,
          observation_ms: options.observationMs,
          include_accessibility_text: options.includeAccessibilityText,
          include_console_text: options.includeConsoleText,
          include_json_body_shapes: options.includeJsonBodyShapes,
          include_websocket_shapes: options.includeWebsocketShapes,
          include_script_sources: options.includeScriptSources,
          include_storage_keys: options.includeStorageKeys,
          include_storage_fingerprints: options.includeStorageFingerprints,
        });
        if (!parsed.success)
          return browserCliError(new AnalysisInputError("inspect_web_page"));
        const result = await inspectWebPage(context.provider, parsed.data);
        return result.ok ? result.value : browserCliError(result.error);
      }),
  });
};

const registerBundleAnalysis = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.analyzeWebBundle, {
    description:
      "Capture and statically analyze a page bundle, defaulting to the selected target origin",
    args: z.object({
      endpoint: z.string().describe("Configured loopback CDP HTTP endpoint"),
      targetId: z.string().describe("Target ID from list-browser-targets"),
    }),
    options: z.object({
      ...browserScopeOptions,
      observationMs: observationDuration(500),
      fetchSourceMaps: z
        .boolean()
        .default(false)
        .describe("Fetch source maps referenced by captured scripts"),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "analyze-web-bundle", async () => {
        const context = browserContext();
        const parsed = analyzeWebBundleInputSchema.safeParse({
          cdp_endpoint: args.endpoint,
          allowed_origins: options.allowedOrigins,
          target_id: args.targetId,
          observation_ms: options.observationMs,
          include_script_sources: true,
          fetch_source_maps: options.fetchSourceMaps,
        });
        if (!parsed.success)
          return browserCliError(new AnalysisInputError("analyze_web_bundle"));
        const result = await analyzeWebBundle(context.provider, parsed.data);
        return result.ok ? result.value : browserCliError(result.error);
      }),
  });
};

const registerObservationSession = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.observeWebSession, {
    description: "Observe user-driven page navigation during a chosen window",
    args: z.object({
      endpoint: z.string().describe("Configured loopback CDP HTTP endpoint"),
      targetId: z.string().describe("Target ID from list-browser-targets"),
    }),
    options: z.object({
      ...browserScopeOptions,
      observationMs: observationDuration(10_000, 1),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "observe-web-session", async () => {
        const context = browserContext();
        const parsed = observeWebSessionInputSchema.safeParse({
          cdp_endpoint: args.endpoint,
          allowed_origins: options.allowedOrigins,
          target_id: args.targetId,
          observation_ms: options.observationMs,
        });
        if (!parsed.success)
          return browserCliError(new AnalysisInputError("observe_web_session"));
        const result = await observeWebSession(context.provider, parsed.data);
        return result.ok ? result.value : browserCliError(result.error);
      }),
  });
};
