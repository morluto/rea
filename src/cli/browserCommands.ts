import { parseCliJsonInput } from "../cliJsonInput.js";
import {
  fetchedSourceMapLimitCliOptions,
  sourceMapLimitsFromCli,
} from "./sourceMapLimits.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { webBundleDeliveryOptions } from "./javascriptRouteDelivery.js";
import {
  deliverCliAnalysisEvidence,
  parseCliAnalysisEvidenceDelivery,
} from "./analysisEvidenceDelivery.js";
import { webRoutesDeliverySchema } from "../domain/analysisView/javascriptRoutesView.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { Cli, z } from "incur";

import { browserCliError } from "./browserCliError.js";
import { createBrowserObservationProvider } from "../composition/browserObservation.js";
import {
  analyzeWebBundle,
  inspectWebPage,
  listBrowserTargets,
  observeWebSession,
} from "../application/BrowserObservationService.js";
import { logCliCommand } from "../cliLogging.js";
import {
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
} from "../domain/browserObservation.js";
import { analyzeWebBundleInputSchema } from "../domain/webBundleAnalysis.js";
import { observeWebSessionInputSchema } from "../domain/browserSession.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { Logger } from "pino";
import { cliDomainInput } from "./domainInput.js";
import { cliDecimalField } from "./options.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import {
  browserPageInspectionOptions,
  observationDuration,
  passiveBrowserScopeOptions,
  selectedCommandTimeout,
  selectedDiscoveryTimeout,
} from "../cliObservationOptions.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

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
      endpoint: cliDomainInput(
        listBrowserTargetsInputSchema.shape.cdp_endpoint,
      ),
    }),
    options: z.object({
      allowedOrigins: passiveBrowserScopeOptions.allowedOrigins,
      discoveryTimeoutMs: passiveBrowserScopeOptions.discoveryTimeoutMs,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, "list-browser-targets", async () => {
          const provider = createBrowserObservationProvider();
          const input = {
            cdp_endpoint: args.endpoint,
            allowed_origins: options.allowedOrigins,
            ...selectedDiscoveryTimeout(options.discoveryTimeoutMs),
          };
          const parsed = listBrowserTargetsInputSchema.safeParse(input);
          if (!parsed.success)
            return browserCliError(
              analysisInputErrorFromIssues(
                "list_browser_targets",
                parsed.error.issues,
                input,
              ),
            );
          return await finishAnalysisCommand(
            () => listBrowserTargets(provider, parsed.data, { signal }),
            {
              close: async () => {
                await provider.close?.();
              },
            },
            provider.identity().id,
            "list_browser_targets",
            signal,
          ).then(projectCliAnalysisResult);
        }),
      ),
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
      endpoint: cliDomainInput(
        listBrowserTargetsInputSchema.shape.cdp_endpoint,
      ),
      targetId: observeWebSessionInputSchema.shape.target_id.describe(
        "Target ID from list-browser-targets",
      ),
    }),
    options: browserPageInspectionOptions,
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, "inspect-web-page", async () => {
          const provider = createBrowserObservationProvider();
          const input = {
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
            ...selectedDiscoveryTimeout(options.discoveryTimeoutMs),
            ...selectedCommandTimeout(options.commandTimeoutMs),
          };
          const parsed = inspectWebPageInputSchema.safeParse(input);
          if (!parsed.success)
            return browserCliError(
              analysisInputErrorFromIssues(
                "inspect_web_page",
                parsed.error.issues,
                input,
              ),
            );
          return await finishAnalysisCommand(
            () => inspectWebPage(provider, parsed.data, { signal }),
            {
              close: async () => {
                await provider.close?.();
              },
            },
            provider.identity().id,
            "inspect_web_page",
            signal,
          ).then(projectCliAnalysisResult);
        }),
      ),
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
      endpoint: cliDomainInput(
        listBrowserTargetsInputSchema.shape.cdp_endpoint,
      ),
      targetId: observeWebSessionInputSchema.shape.target_id.describe(
        "Target ID from list-browser-targets",
      ),
    }),
    options: z.object({
      ...passiveBrowserScopeOptions,
      ...webBundleDeliveryOptions,
      observationMs: observationDuration(500),
      semanticPrecision: z
        .string()
        .optional()
        .describe(
          "Inline JSON or JSON file of semantic_precision evaluator budgets for each inert script.",
        ),
      fetchSourceMaps: z
        .boolean()
        .default(false)
        .describe("Fetch source maps referenced by captured scripts"),
      maxHeapMb: cliDecimalField(analyzeWebBundleInputSchema.shape.max_heap_mb),
      analysisTimeoutMs: cliDecimalField(
        analyzeWebBundleInputSchema.shape.analysis_timeout_ms,
      ),
      totalAnalysisTimeoutMs: cliDecimalField(
        analyzeWebBundleInputSchema.shape.total_analysis_timeout_ms,
      ),
      ...fetchedSourceMapLimitCliOptions,
      sourceMapFetchTimeoutMs: cliDecimalField(
        analyzeWebBundleInputSchema.shape.source_map_fetch_timeout_ms,
      ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, "analyze-web-bundle", async () => {
          const delivery = parseCliAnalysisEvidenceDelivery(
            "analyze_web_bundle",
            options,
            webRoutesDeliverySchema,
          );
          if (!delivery.ok) return projectAnalysisError(delivery.error);
          const precision =
            options.semanticPrecision === undefined
              ? undefined
              : await parseCliJsonInput(
                  options.semanticPrecision,
                  "analyze_web_bundle",
                  signal,
                );
          if (precision !== undefined && !precision.ok) return precision.error;
          const provider = createBrowserObservationProvider();
          const input = {
            cdp_endpoint: args.endpoint,
            allowed_origins: options.allowedOrigins,
            target_id: args.targetId,
            observation_ms: options.observationMs,
            include_script_sources: true,
            fetch_source_maps: options.fetchSourceMaps,
            ...(precision === undefined
              ? {}
              : { semantic_precision: precision.value }),
            ...sourceMapLimitsFromCli(options),
            ...(options.maxHeapMb === undefined
              ? {}
              : { max_heap_mb: options.maxHeapMb }),
            ...(options.analysisTimeoutMs === undefined
              ? {}
              : { analysis_timeout_ms: options.analysisTimeoutMs }),
            ...(options.totalAnalysisTimeoutMs === undefined
              ? {}
              : { total_analysis_timeout_ms: options.totalAnalysisTimeoutMs }),
            ...(options.sourceMapFetchTimeoutMs === undefined
              ? {}
              : {
                  source_map_fetch_timeout_ms: options.sourceMapFetchTimeoutMs,
                }),
            ...selectedDiscoveryTimeout(options.discoveryTimeoutMs),
            ...selectedCommandTimeout(options.commandTimeoutMs),
          };
          const parsed = analyzeWebBundleInputSchema.safeParse(input);
          if (!parsed.success)
            return browserCliError(
              analysisInputErrorFromIssues(
                "analyze_web_bundle",
                parsed.error.issues,
                input,
              ),
            );
          return deliverCliAnalysisEvidence({
            ...delivery.value,
            run: () => analyzeWebBundle(provider, parsed.data, { signal }),
            service: {
              close: async () => {
                await provider.close?.();
              },
            },
            providerId: provider.identity().id,
            operation: "analyze_web_bundle",
            signal,
          });
        }),
      ),
  });
};

const registerObservationSession = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.observeWebSession, {
    description: "Observe user-driven page navigation during a chosen window",
    args: z.object({
      endpoint: cliDomainInput(
        listBrowserTargetsInputSchema.shape.cdp_endpoint,
      ),
      targetId: observeWebSessionInputSchema.shape.target_id.describe(
        "Target ID from list-browser-targets",
      ),
    }),
    options: z.object({
      ...passiveBrowserScopeOptions,
      observationMs: observationDuration(10_000, 1),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, "observe-web-session", async () => {
          const provider = createBrowserObservationProvider();
          const input = {
            cdp_endpoint: args.endpoint,
            allowed_origins: options.allowedOrigins,
            target_id: args.targetId,
            observation_ms: options.observationMs,
            ...selectedDiscoveryTimeout(options.discoveryTimeoutMs),
            ...selectedCommandTimeout(options.commandTimeoutMs),
          };
          const parsed = observeWebSessionInputSchema.safeParse(input);
          if (!parsed.success)
            return browserCliError(
              analysisInputErrorFromIssues(
                "observe_web_session",
                parsed.error.issues,
                input,
              ),
            );
          return await finishAnalysisCommand(
            () => observeWebSession(provider, parsed.data, { signal }),
            {
              close: async () => {
                await provider.close?.();
              },
            },
            provider.identity().id,
            "observe_web_session",
            signal,
          ).then(projectCliAnalysisResult);
        }),
      ),
  });
};
