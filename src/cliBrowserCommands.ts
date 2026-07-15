import { Cli, z } from "incur";

import {
  analyzeWebBundle,
  inspectWebPage,
  listBrowserTargets,
  observeWebSession,
} from "./application/BrowserObservationService.js";
import { loadConfiguredPermissionAuthority } from "./application/PermissionConfiguration.js";
import { CdpBrowserProvider } from "./browser/CdpBrowserProvider.js";
import { logCliCommand } from "./cliLogging.js";
import { parseConfig } from "./config.js";
import {
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
} from "./domain/browserObservation.js";
import { analyzeWebBundleInputSchema } from "./domain/webBundleAnalysis.js";
import { observeWebSessionInputSchema } from "./domain/browserSession.js";
import { AnalysisInputError, projectAnalysisError } from "./domain/errors.js";
import type { JsonValue } from "./domain/jsonValue.js";
import type { Logger } from "./logger.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";

const browserScopeOptions = {
  allowedOrigins: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Exact origins to observe; defaults to REA_BROWSER_ALLOWED_ORIGINS_JSON",
    ),
  approved: z.boolean().default(false).describe("Approve passive observation"),
};

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
    description: "List approved pages from a user-owned loopback CDP browser",
    args: z.object({
      endpoint: z.string().describe("Configured loopback CDP HTTP endpoint"),
    }),
    options: z.object({
      ...browserScopeOptions,
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(100),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "list-browser-targets", async () => {
        const context = await browserContext();
        if (!context.ok) return context.error;
        const parsed = listBrowserTargetsInputSchema.safeParse({
          cdp_endpoint: args.endpoint,
          allowed_origins:
            options.allowedOrigins ?? context.allowedBrowserOrigins,
          approved: options.approved,
          offset: options.offset,
          limit: options.limit,
        });
        if (!parsed.success)
          return cliError(new AnalysisInputError("list_browser_targets"));
        const result = await listBrowserTargets(
          context.provider,
          context.authority,
          parsed.data,
        );
        return result.ok ? result.value : cliError(result.error);
      }),
  });
};

const registerPageInspection = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectWebPage, {
    description: "Passively inspect one approved page through CDP",
    args: z.object({
      endpoint: z.string().describe("Configured loopback CDP HTTP endpoint"),
      targetId: z.string().describe("Target ID from list-browser-targets"),
    }),
    options: z.object({
      ...browserScopeOptions,
      observationMs: z.number().int().min(0).max(10_000).default(500),
      includeAccessibilityText: z.boolean().default(false),
      includeConsoleText: z.boolean().default(false),
      consoleTextApproved: z.boolean().default(false),
      includeJsonBodyShapes: z.boolean().default(false),
      jsonBodySchemaApproved: z.boolean().default(false),
      includeWebsocketShapes: z.boolean().default(false),
      websocketShapeApproved: z.boolean().default(false),
      includeScriptSources: z.boolean().default(false),
      includeStorageKeys: z.boolean().default(false),
      maxFrames: z.number().int().min(1).max(1_000).default(200),
      maxDomNodes: z.number().int().min(1).max(10_000).default(2_000),
      maxAxNodes: z.number().int().min(1).max(10_000).default(2_000),
      maxAxTextFieldBytes: z
        .number()
        .int()
        .min(1)
        .max(16 * 1_024)
        .default(1_024),
      maxTotalAxTextBytes: z
        .number()
        .int()
        .min(1)
        .max(1_024 * 1_024)
        .default(64 * 1_024),
      maxScripts: z.number().int().min(1).max(1_000).default(200),
      maxResources: z.number().int().min(1).max(10_000).default(2_000),
      maxWorkers: z.number().int().min(1).max(5_000).default(500),
      maxStorageKeys: z.number().int().min(1).max(10_000).default(1_000),
      maxScriptSourceBytes: z
        .number()
        .int()
        .min(1)
        .max(4 * 1_024 * 1_024)
        .default(1_024 * 1_024),
      maxTotalScriptSourceBytes: z
        .number()
        .int()
        .min(1)
        .max(16 * 1_024 * 1_024)
        .default(4 * 1_024 * 1_024),
      maxNetworkEvents: z.number().int().min(1).max(10_000).default(1_000),
      maxConsoleEvents: z.number().int().min(1).max(2_000).default(200),
      maxConsoleTextFieldBytes: z
        .number()
        .int()
        .min(1)
        .max(16 * 1_024)
        .default(1_024),
      maxTotalConsoleTextBytes: z
        .number()
        .int()
        .min(1)
        .max(1_024 * 1_024)
        .default(64 * 1_024),
      maxJsonBodyBytes: z
        .number()
        .int()
        .min(1)
        .max(4 * 1_024 * 1_024)
        .default(1_024 * 1_024),
      maxTotalJsonBodyBytes: z
        .number()
        .int()
        .min(1)
        .max(16 * 1_024 * 1_024)
        .default(4 * 1_024 * 1_024),
      maxJsonShapeNodes: z.number().int().min(1).max(100_000).default(5_000),
      maxJsonShapeDepth: z.number().int().min(1).max(100).default(20),
      maxWebsocketEvents: z.number().int().min(1).max(5_000).default(500),
      maxWebsocketShapeBytes: z
        .number()
        .int()
        .min(1)
        .max(1_024 * 1_024)
        .default(64 * 1_024),
      maxTotalWebsocketShapeBytes: z
        .number()
        .int()
        .min(1)
        .max(16 * 1_024 * 1_024)
        .default(1_024 * 1_024),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "inspect-web-page", async () => {
        const context = await browserContext();
        if (!context.ok) return context.error;
        const parsed = inspectWebPageInputSchema.safeParse({
          cdp_endpoint: args.endpoint,
          allowed_origins:
            options.allowedOrigins ?? context.allowedBrowserOrigins,
          approved: options.approved,
          target_id: args.targetId,
          observation_ms: options.observationMs,
          include_accessibility_text: options.includeAccessibilityText,
          include_console_text: options.includeConsoleText,
          console_text_approved: options.consoleTextApproved,
          include_json_body_shapes: options.includeJsonBodyShapes,
          json_body_schema_approved: options.jsonBodySchemaApproved,
          include_websocket_shapes: options.includeWebsocketShapes,
          websocket_shape_approved: options.websocketShapeApproved,
          include_script_sources: options.includeScriptSources,
          include_storage_keys: options.includeStorageKeys,
          limits: {
            max_frames: options.maxFrames,
            max_dom_nodes: options.maxDomNodes,
            max_ax_nodes: options.maxAxNodes,
            max_ax_text_field_bytes: options.maxAxTextFieldBytes,
            max_total_ax_text_bytes: options.maxTotalAxTextBytes,
            max_scripts: options.maxScripts,
            max_resources: options.maxResources,
            max_workers: options.maxWorkers,
            max_storage_keys: options.maxStorageKeys,
            max_script_source_bytes: options.maxScriptSourceBytes,
            max_total_script_source_bytes: options.maxTotalScriptSourceBytes,
            max_network_events: options.maxNetworkEvents,
            max_console_events: options.maxConsoleEvents,
            max_console_text_field_bytes: options.maxConsoleTextFieldBytes,
            max_total_console_text_bytes: options.maxTotalConsoleTextBytes,
            max_json_body_bytes: options.maxJsonBodyBytes,
            max_total_json_body_bytes: options.maxTotalJsonBodyBytes,
            max_json_shape_nodes: options.maxJsonShapeNodes,
            max_json_shape_depth: options.maxJsonShapeDepth,
            max_websocket_events: options.maxWebsocketEvents,
            max_websocket_shape_bytes: options.maxWebsocketShapeBytes,
            max_total_websocket_shape_bytes:
              options.maxTotalWebsocketShapeBytes,
          },
        });
        if (!parsed.success)
          return cliError(new AnalysisInputError("inspect_web_page"));
        const result = await inspectWebPage(
          context.provider,
          context.authority,
          parsed.data,
        );
        return result.ok ? result.value : cliError(result.error);
      }),
  });
};

const registerBundleAnalysis = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.analyzeWebBundle, {
    description: "Capture and statically analyze an approved page bundle",
    args: z.object({
      endpoint: z.string().describe("Configured loopback CDP HTTP endpoint"),
      targetId: z.string().describe("Target ID from list-browser-targets"),
    }),
    options: z.object({
      ...browserScopeOptions,
      sourceCaptureApproved: z.boolean().default(false),
      observationMs: z.number().int().min(0).max(10_000).default(500),
      fetchSourceMaps: z.boolean().default(false),
      sourceMapFetchApproved: z.boolean().default(false),
      maxFindings: z.number().int().min(1).max(10_000).default(1_000),
      maxAstNodes: z.number().int().min(1).max(2_000_000).default(250_000),
      maxSourceMaps: z.number().int().min(1).max(1_000).default(100),
      maxSourceMapBytes: z
        .number()
        .int()
        .min(1)
        .max(16 * 1_024 * 1_024)
        .default(4 * 1_024 * 1_024),
      maxTotalSourceMapBytes: z
        .number()
        .int()
        .min(1)
        .max(64 * 1_024 * 1_024)
        .default(16 * 1_024 * 1_024),
      maxSourceMapMappings: z
        .number()
        .int()
        .min(1)
        .max(100_000)
        .default(10_000),
      maxOriginalSources: z.number().int().min(1).max(20_000).default(2_000),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "analyze-web-bundle", async () => {
        const context = await browserContext();
        if (!context.ok) return context.error;
        const parsed = analyzeWebBundleInputSchema.safeParse({
          cdp_endpoint: args.endpoint,
          allowed_origins:
            options.allowedOrigins ?? context.allowedBrowserOrigins,
          approved: options.approved,
          target_id: args.targetId,
          observation_ms: options.observationMs,
          include_script_sources: true,
          source_capture_approved: options.sourceCaptureApproved,
          fetch_source_maps: options.fetchSourceMaps,
          source_map_fetch_approved: options.sourceMapFetchApproved,
          analysis_limits: {
            max_findings: options.maxFindings,
            max_ast_nodes: options.maxAstNodes,
            max_source_maps: options.maxSourceMaps,
            max_source_map_bytes: options.maxSourceMapBytes,
            max_total_source_map_bytes: options.maxTotalSourceMapBytes,
            max_source_map_mappings: options.maxSourceMapMappings,
            max_original_sources: options.maxOriginalSources,
          },
        });
        if (!parsed.success)
          return cliError(new AnalysisInputError("analyze_web_bundle"));
        const result = await analyzeWebBundle(
          context.provider,
          context.authority,
          parsed.data,
        );
        return result.ok ? result.value : cliError(result.error);
      }),
  });
};

const registerObservationSession = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.observeWebSession, {
    description: "Observe user-driven page navigation during a bounded window",
    args: z.object({
      endpoint: z.string().describe("Configured loopback CDP HTTP endpoint"),
      targetId: z.string().describe("Target ID from list-browser-targets"),
    }),
    options: z.object({
      ...browserScopeOptions,
      observationMs: z.number().int().min(1).max(60_000).default(10_000),
      maxTimelineEvents: z.number().int().min(1).max(20_000).default(2_000),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "observe-web-session", async () => {
        const context = await browserContext();
        if (!context.ok) return context.error;
        const parsed = observeWebSessionInputSchema.safeParse({
          cdp_endpoint: args.endpoint,
          allowed_origins:
            options.allowedOrigins ?? context.allowedBrowserOrigins,
          target_id: args.targetId,
          approved: options.approved,
          observation_ms: options.observationMs,
          max_timeline_events: options.maxTimelineEvents,
        });
        if (!parsed.success)
          return cliError(new AnalysisInputError("observe_web_session"));
        const result = await observeWebSession(
          context.provider,
          context.authority,
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

const cliError = (
  error: Parameters<typeof projectAnalysisError>[0],
): JsonValue => ({
  error: "Browser observation failed",
  ...projectAnalysisError(error),
});
