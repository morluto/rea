import { deliverCliAnalysisEvidence } from "./analysisEvidenceDelivery.js";

import type { CliInstance } from "./types.js";

import { browserCliError } from "./browserCliError.js";
import { createBrowserObservationProvider } from "../composition/browserObservation.js";
import {
  analyzeWebBundle,
  inspectWebPage,
  listBrowserTargets,
  observeWebSession,
} from "../application/BrowserObservationService.js";

import { analyzeWebBundleInputSchema } from "../domain/webBundleAnalysis.js";

import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { Logger } from "pino";

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
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
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
        include_cache_storage_entries: {
          description:
            "Include Cache Storage entry metadata without cached bodies",
        },
      },
    },
    observeThroughBrowser(inspectPage, inspectWebPage),
  );
  registerBundleAnalysis(cli, logger, environment);
  const observeSession = contractNamed(
    BROWSER_TOOL_CONTRACTS,
    "observe_web_session",
  );
  registerContractCommand(
    cli,
    logger,
    observeSession,
    {
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
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const contract = contractNamed(BROWSER_TOOL_CONTRACTS, "analyze_web_bundle");
  const pageInspectionOnly =
    "page inspection extras are not part of bundle analysis on the CLI; use inspect-web-page";
  registerContractCommand(
    cli,
    logger,
    contract,
    {
      description:
        "Capture and statically analyze a page bundle, defaulting to the selected target origin",
      ...browserTargetProjection,
      evidenceDelivery: true,
      viewDelivery: { invalidJson: "view must be valid JSON" },
      jsonInputs: {
        semantic_precision:
          "semanticPrecision must be inline JSON or a JSON file path",
      },
      flatten: {
        source_map_limits: {
          output_bytes: { name: "sourceMapOutputBytes" },
          decoded_rows: { name: "sourceMapDecodedRows" },
          decoded_segments: { name: "sourceMapDecodedSegments" },
          decoded_records: { name: "sourceMapDecodedRecords" },
          section_depth: { name: "sourceMapSectionDepth" },
          fetch_bytes: { name: "sourceMapFetchBytes" },
        },
      },
      fields: {
        ...browserTargetProjection.fields,
        observation_ms: {
          description: "Observation duration in milliseconds",
        },
        semantic_precision: {
          description:
            "Inline JSON or JSON file of semantic_precision evaluator budgets for each inert script.",
        },
        fetch_source_maps: {
          description: "Fetch source maps referenced by captured scripts",
        },
        view: {
          description:
            "JSON web-bundle (endpoints, inferences, summary) or javascript-routes view; requires --detail summary and --evidence_output",
        },
      },
      omit: {
        include_script_sources:
          "bundle analysis always reads script sources, the contract default",
        include_accessibility_text: pageInspectionOnly,
        include_console_text: pageInspectionOnly,
        include_json_body_shapes: pageInspectionOnly,
        include_websocket_shapes: pageInspectionOnly,
        include_storage_keys: pageInspectionOnly,
        include_storage_fingerprints: pageInspectionOnly,
        include_cache_storage_entries: pageInspectionOnly,
      },
    },
    async (input, { signal, delivery }) => {
      // Delivery fields select the reply; the analysis takes the rest.
      const parsed = analyzeWebBundleInputSchema.safeParse(input);
      if (!parsed.success)
        return browserCliError(
          analysisInputErrorFromIssues(
            contract.name,
            parsed.error.issues,
            input,
          ),
        );
      const provider = createBrowserObservationProvider(undefined, environment);
      return deliverCliAnalysisEvidence({
        ...delivery!,
        run: () => analyzeWebBundle(provider, parsed.data, { signal }),
        service: {
          close: async () => {
            await provider.close?.();
          },
        },
        providerId: provider.identity().id,
        operation: contract.name,
        signal,
      });
    },
  );
};
