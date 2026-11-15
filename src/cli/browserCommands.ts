import { parseCliJsonInput } from "../cliJsonInput.js";
import {
  fetchedSourceMapLimitCliOptions,
  sourceMapLimitsFromCli,
} from "./sourceMapLimits.js";

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
import { listBrowserTargetsInputSchema } from "../domain/browserObservation.js";
import { analyzeWebBundleInputSchema } from "../domain/webBundleAnalysis.js";
import { observeWebSessionInputSchema } from "../domain/browserSession.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { Logger } from "pino";
import { cliDomainInput } from "./domainInput.js";
import { cliDecimalField } from "./options.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import {
  observationDuration,
  passiveBrowserScopeOptions,
  selectedCommandTimeout,
  selectedDiscoveryTimeout,
} from "../cliObservationOptions.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import { BROWSER_TOOL_CONTRACTS } from "../contracts/browserToolContracts.js";
import {
  browserTargetProjection,
  observeThroughBrowser,
} from "./browserContractCommands.js";

import { cliProgressReporter } from "./cliProgress.js";

/** Register CLI equivalents of the passive browser MCP tools. */
export const registerBrowserCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  const listTargets = contractNamed(
    BROWSER_TOOL_CONTRACTS,
    "list_browser_targets",
  );
  registerContractCommand(
    cli,
    logger,
    listTargets,
    {
      command: CLI_COMMANDS.listBrowserTargets,
      description:
        "List page targets from a selected loopback CDP browser, optionally filtered by origin",
      positionals: ["cdp_endpoint"],
      fields: {
        cdp_endpoint: { name: "endpoint" },
        allowed_origins: { description: "Optional exact-origin filter" },
      },
    },
    observeThroughBrowser(listTargets, listBrowserTargets),
  );
  const inspectPage = contractNamed(BROWSER_TOOL_CONTRACTS, "inspect_web_page");
  registerContractCommand(
    cli,
    logger,
    inspectPage,
    {
      command: CLI_COMMANDS.inspectWebPage,
      description:
        "Passively inspect one page through CDP, defaulting to its current origin",
      ...browserTargetProjection,
      fields: {
        ...browserTargetProjection.fields,
        observation_ms: {
          description: "Observation duration in milliseconds",
        },
        include_accessibility_text: {
          description: "Include accessibility text",
        },
        include_console_text: { description: "Include console message text" },
        include_json_body_shapes: {
          description: "Include structural shapes of JSON response bodies",
        },
        include_websocket_shapes: {
          description: "Include structural shapes of WebSocket payloads",
        },
        include_script_sources: {
          description: "Include JavaScript source text",
        },
        include_storage_keys: {
          description: "Include storage key names without values",
        },
        include_storage_fingerprints: {
          description: "Include content-derived storage fingerprints",
        },
      },
    },
    observeThroughBrowser(inspectPage, inspectWebPage),
  );
  registerBundleAnalysis(cli, logger);
  const observeSession = contractNamed(
    BROWSER_TOOL_CONTRACTS,
    "observe_web_session",
  );
  registerContractCommand(
    cli,
    logger,
    observeSession,
    {
      command: CLI_COMMANDS.observeWebSession,
      description: "Observe user-driven page navigation during a chosen window",
      ...browserTargetProjection,
      fields: {
        ...browserTargetProjection.fields,
        observation_ms: {
          description: "Observation duration in milliseconds",
        },
      },
    },
    observeThroughBrowser(observeSession, (provider, input, options) =>
      observeWebSession(provider, input, {
        ...options,
        // Report the armed observation on stderr, as MCP does.
        progress: cliProgressReporter,
      }),
    ),
  );
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
