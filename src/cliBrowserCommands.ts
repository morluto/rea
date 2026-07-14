import { Cli, z } from "incur";

import {
  inspectWebPage,
  listBrowserTargets,
} from "./application/BrowserObservationService.js";
import { loadConfiguredPermissionAuthority } from "./application/PermissionConfiguration.js";
import { CdpBrowserProvider } from "./browser/CdpBrowserProvider.js";
import { logCliCommand } from "./cliLogging.js";
import { parseConfig } from "./config.js";
import {
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
} from "./domain/browserObservation.js";
import { AnalysisInputError, projectAnalysisError } from "./domain/errors.js";
import type { JsonValue } from "./domain/jsonValue.js";
import type { Logger } from "./logger.js";

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
};

const registerTargetList = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command("list-browser-targets", {
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
  cli.command("inspect-web-page", {
    description: "Passively inspect one approved page through CDP",
    args: z.object({
      endpoint: z.string().describe("Configured loopback CDP HTTP endpoint"),
      targetId: z.string().describe("Target ID from list-browser-targets"),
    }),
    options: z.object({
      ...browserScopeOptions,
      observationMs: z.number().int().min(0).max(10_000).default(500),
      includeScriptSources: z.boolean().default(false),
      includeStorageKeys: z.boolean().default(false),
      maxFrames: z.number().int().min(1).max(1_000).default(200),
      maxDomNodes: z.number().int().min(1).max(10_000).default(2_000),
      maxAxNodes: z.number().int().min(1).max(10_000).default(2_000),
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
      maxWebsocketEvents: z.number().int().min(1).max(5_000).default(500),
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
          include_script_sources: options.includeScriptSources,
          include_storage_keys: options.includeStorageKeys,
          limits: {
            max_frames: options.maxFrames,
            max_dom_nodes: options.maxDomNodes,
            max_ax_nodes: options.maxAxNodes,
            max_scripts: options.maxScripts,
            max_resources: options.maxResources,
            max_workers: options.maxWorkers,
            max_storage_keys: options.maxStorageKeys,
            max_script_source_bytes: options.maxScriptSourceBytes,
            max_total_script_source_bytes: options.maxTotalScriptSourceBytes,
            max_network_events: options.maxNetworkEvents,
            max_console_events: options.maxConsoleEvents,
            max_websocket_events: options.maxWebsocketEvents,
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
