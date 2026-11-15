import {
  webCaptureComparisonRequestSchema,
  webScreenshotComparisonRequestSchema,
} from "./webComparisonInputContracts.js";
import { webScreenshotComparisonResultSchema } from "../domain/webComparisonSources.js";
import { z } from "zod";
import {
  javaScriptRoutesCompleteDeliveryShape,
  webRoutesSummaryDeliveryShape,
} from "../domain/analysisView/javascriptRoutesView.js";
import {
  javaScriptRoutesViewResultSchema,
  webBundleSummaryViewResultSchema,
  webBundlePageViewResultSchema,
} from "../domain/analysisView/analysisView.js";
import type { ToolContract } from "./toolContractTypes.js";
import {
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
} from "../domain/browserObservation.js";
import {
  browserTargetListSchema,
  webPageInspectionSchema,
} from "../domain/browserObservationSchemas.js";
import {
  analyzeWebBundleInputSchema,
  webBundleAnalysisSchema,
} from "../domain/webBundleAnalysis.js";
import {
  observeWebSessionInputSchema,
  webObservationSessionSchema,
} from "../domain/browserSession.js";
import {
  discoverWebMcpToolsInputSchema,
  webMcpDiscoverySchema,
} from "../domain/webMcpDiscovery.js";
import { browserCaptureComparisonSchema } from "../domain/browserCaptureComparison.js";
import { DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS } from "../domain/browserScenarioCaptureLimits.js";
import {
  captureWebScreenshotInputSchema,
  webScreenshotSchema,
} from "../domain/webScreenshot.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

const listOutputSchema = evidenceResultOf(browserTargetListSchema);
const inspectionOutputSchema = evidenceResultOf(webPageInspectionSchema);
export const analyzeWebBundleRequestSchema = z
  .discriminatedUnion("detail", [
    analyzeWebBundleInputSchema.extend(javaScriptRoutesCompleteDeliveryShape),
    analyzeWebBundleInputSchema.extend(webRoutesSummaryDeliveryShape),
  ])
  .meta({ "x-rea-root-discriminator": "detail" });
const bundleOutputSchema = evidenceResultOf(
  z.union([
    webBundleAnalysisSchema,
    javaScriptRoutesViewResultSchema,
    webBundleSummaryViewResultSchema,
    webBundlePageViewResultSchema,
  ]),
);
const observationSessionOutputSchema = evidenceResultOf(
  webObservationSessionSchema,
);
const webMcpOutputSchema = evidenceResultOf(webMcpDiscoverySchema);
const captureDiffOutputSchema = evidenceResultOf(
  browserCaptureComparisonSchema,
);
const screenshotOutputSchema = evidenceResultOf(webScreenshotSchema);
const screenshotDiffOutputSchema = evidenceResultOf(
  webScreenshotComparisonResultSchema,
);

const endpoint = "http://127.0.0.1:9222";
const origin = "https://app.example.test";
const scenarioUrl = {
  url: `${origin}/`,
  origin,
  query_parameter_names: [],
  redacted: false,
};
const scenarioCompleteness = {
  status: "complete",
  equality_eligible: true,
  missing_sections: [],
  truncated_sections: [],
};
const scenarioArtifacts = {
  screenshot: { state: "not_requested" },
  dom: { state: "not_requested" },
  accessibility: { state: "not_requested" },
  url: { state: "not_requested" },
  history: { state: "not_requested" },
  storage: { state: "not_requested" },
};
const exampleScenarioCapture = () => ({
  browser: {
    mode: "connect",
    process_ownership: "external",
    cleanup: "disconnected-external",
    product: "Chromium",
    version: "149",
  },
  scenario: {
    start_origin: origin,
    action_count: 1,
    secret_references: [],
    network_content: {
      request_body: false,
      response_body: false,
      header_values: false,
    },
    event_families: [],
    limits: DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS,
  },
  duration_ms: 10,
  steps: [
    {
      step_index: 0,
      step_id: "scenario_start",
      action: "scenario_start",
      status: "completed",
      elapsed_ms: 0,
      before_url: scenarioUrl,
      after_url: scenarioUrl,
      error: null,
      event_sequence_start: 1,
      event_sequence_end: 0,
      artifacts: scenarioArtifacts,
      completeness: scenarioCompleteness,
    },
    {
      step_index: 1,
      step_id: "open-settings",
      action: "click",
      status: "completed",
      elapsed_ms: 10,
      before_url: scenarioUrl,
      after_url: scenarioUrl,
      error: null,
      event_sequence_start: 1,
      event_sequence_end: 0,
      artifacts: scenarioArtifacts,
      completeness: scenarioCompleteness,
    },
  ],
  events: {
    retained: 0,
    dropped: 0,
    items: [],
    omissions: {
      by_kind: [],
      network_transactions: [],
      network_transaction_range: null,
    },
  },
  completeness: {
    status: "incomplete",
    equality_eligible: false,
    missing_sections: ["events"],
    truncated_sections: [],
  },
  limitations: [
    "CDP attachment cannot recover pre-attach events or guarantee launch-time context options.",
    "Attached locale en-US applies to Intl formatting only; navigator.language(s) and Accept-Language remain caller-controlled. Use launch mode for matching page and request languages.",
    "Detaching a CDP page session may clear caller-owned navigator.platform emulation. REA cannot snapshot the caller's complete user-agent/client-hint state before attachment; use launch mode to avoid mutating that external browser.",
  ],
});

/** Passive browser reverse-engineering contracts. */
export const BROWSER_TOOL_CONTRACTS = [
  {
    name: "list_browser_targets",
    ...toolContractMetadata("list_browser_targets"),
    description:
      "List pages exposed by one loopback Chrome DevTools Protocol endpoint, optionally filtered by exact origin. Returns target IDs and URLs; query values and fragments are preserved, with URL userinfo credentials removed. Use a returned target ID with inspect_web_page. discovery_timeout_ms controls discovery; command_timeout_ms does not apply. Browser-socket endpoints remain shared by the active browser provider until it closes or target-session cleanup is unconfirmed; cancellation/deadline on a clean socket releases only this call’s lease.",
    kind: "browser-provider",
    inputSchema: listBrowserTargetsInputSchema,
    outputSchema: listOutputSchema,
    examples: [
      {
        title: "List browser page targets",
        input: {
          cdp_endpoint: endpoint,
        },
      },
    ],
  },
  {
    name: "inspect_web_page",
    ...toolContractMetadata("inspect_web_page"),
    description:
      "Passively inspect one selected page target through CDP without evaluating JavaScript, navigating, clicking, closing, or mutating the page. If no origin filter is supplied, capture is scoped to the target's current origin. Returns DOM structure, accessibility, scripts, resources, attach-window network and console metadata, workers, and redacted storage inventory as Evidence.",
    kind: "browser-provider",
    inputSchema: inspectWebPageInputSchema,
    outputSchema: inspectionOutputSchema,
    examples: [
      {
        title: "Inspect one browser page",
        input: {
          cdp_endpoint: endpoint,
          target_id: "TARGET_ID_FROM_LIST_BROWSER_TARGETS",
        },
      },
    ],
  },
  {
    name: "analyze_web_bundle",
    ...toolContractMetadata("analyze_web_bundle"),
    description:
      'Recover a static chunk graph, route/endpoint candidates, vendor fingerprints and page-declared WebMCP metadata from JavaScript on one selected CDP page. May fetch source maps only from the target origin or explicitly selected origins; application JavaScript is not executed. detail summary retains complete Evidence; view {kind: "web-bundle", collection: "endpoints"} selects endpoint rows, and javascript-routes views select route patterns/occurrences/sources/unknowns. Read later pages with inspect_analysis_view. Static candidates do not establish runtime reachability or a complete route set.',
    kind: "browser-provider",
    inputSchema: analyzeWebBundleRequestSchema,
    outputSchema: bundleOutputSchema,
    examples: [
      {
        title: "Analyze a page bundle",
        input: {
          cdp_endpoint: endpoint,
          target_id: "TARGET_ID_FROM_LIST_BROWSER_TARGETS",
          observation_ms: 500,
          include_accessibility_text: false,
          include_script_sources: true,
          include_storage_keys: false,
          fetch_source_maps: false,
        },
      },
    ],
  },
  {
    name: "observe_web_session",
    ...toolContractMetadata("observe_web_session"),
    description:
      "Arm a CDP observation window of the requested duration while the user operates the page. By default it follows the selected target's current origin; an explicit origin list controls which origins may be retained. Records navigation, redirect, lifecycle, and failure events.",
    kind: "browser-provider",
    inputSchema: observeWebSessionInputSchema,
    outputSchema: observationSessionOutputSchema,
    examples: [
      {
        title: "Observe one external user action",
        input: {
          cdp_endpoint: endpoint,
          target_id: "TARGET_ID_FROM_LIST_BROWSER_TARGETS",
          observation_ms: 10_000,
        },
      },
    ],
  },
  {
    name: "discover_webmcp_tools",
    ...toolContractMetadata("discover_webmcp_tools"),
    description:
      "Passively inventory every page-registered WebMCP tool and its complete structural input-schema summary using the experimental CDP WebMCP domain. Metadata is page-declared-untrusted; REA never registers or invokes discovered tools.",
    kind: "browser-provider",
    inputSchema: discoverWebMcpToolsInputSchema,
    outputSchema: webMcpOutputSchema,
    examples: [
      {
        title: "Discover current WebMCP declarations",
        input: {
          cdp_endpoint: endpoint,
          target_id: "TARGET_ID_FROM_LIST_BROWSER_TARGETS",
          observation_ms: 100,
        },
      },
    ],
  },
  {
    name: "compare_web_captures",
    ...toolContractMetadata("compare_web_captures"),
    description:
      "Compare existing web observations offline. For verifiable provenance pass left and right as complete capture_browser_scenario or inspect_web_page Evidence, or exact same-session retained-evidence references. Both sides must have the same operation. Scenario Evidence accepts normalization and an explicit origin_mapping {before_origin, after_origin}; the correspondence is committed and changes only typed URL origins. Derived comparison Evidence retains exact source links for verify_reconstruction. Legacy detached inputs remain supported: before/after inspection wrappers with optional webmcp, or before_scenario/after_scenario normalized captures. Use exactly one input group. Scenario steps align by exact unique step_id; missing, truncated or incompatible observations never establish equality. Returns complete differences and alignment failures inline without contacting a browser.",
    kind: "browser-provider",
    inputSchema: webCaptureComparisonRequestSchema,
    outputSchema: captureDiffOutputSchema,
    examples: [
      {
        title: "Compare two recorded browser scenarios",
        input: {
          before_scenario: exampleScenarioCapture(),
          after_scenario: exampleScenarioCapture(),
          normalization: {
            rules: [
              {
                rule_id: "volatile-build-id",
                artifacts: ["dom", "accessibility"],
                match: "build-123",
                replacement: "[BUILD_ID]",
              },
            ],
          },
        },
      },
      {
        title:
          "Compare authenticated scenario Evidence already retained in this session",
        input: {
          left: {
            kind: "retained-evidence",
            evidence_id: `ev_${"0".repeat(64)}`,
          },
          right: {
            kind: "retained-evidence",
            evidence_id: `ev_${"1".repeat(64)}`,
          },
        },
      },
    ],
  },
  {
    name: "capture_web_screenshot",
    ...toolContractMetadata("capture_web_screenshot"),
    description:
      "Capture the current visible viewport of one configured page as an inline, content-addressed PNG artifact. The operation never scrolls, navigates, or evaluates page JavaScript.",
    kind: "browser-provider",
    inputSchema: captureWebScreenshotInputSchema,
    outputSchema: screenshotOutputSchema,
    examples: [
      {
        title: "Capture a viewport",
        input: {
          cdp_endpoint: endpoint,
          target_id: "TARGET_ID_FROM_LIST_BROWSER_TARGETS",
        },
      },
    ],
  },
  {
    name: "compare_web_screenshots",
    ...toolContractMetadata("compare_web_screenshots"),
    description:
      "Compare captured pixels offline. Pass left/right as complete capture_web_screenshot Evidence or same-session retained references; capture_browser_scenario Evidence also requires an exact shared step_id. An explicit origin_mapping binds differing original/reconstruction scenario origins. Derived comparison Evidence links both observations and commits channel_threshold; verify_reconstruction web-screenshot claims separately declare maximum_changed_ratio. Missing captured pixels return unavailable, never equality. Legacy before/after self-verifying PNG artifacts remain supported without observation provenance. Returns pixel ratios/channel deltas without OCR, browser access or external services; visual agreement does not prove behavior.",
    kind: "browser-provider",
    inputSchema: webScreenshotComparisonRequestSchema,
    outputSchema: screenshotDiffOutputSchema,
    examples: [
      {
        title: "Compare two screenshot artifacts",
        input: {
          before: exampleScreenshot(),
          after: exampleScreenshot(),
          channel_threshold: 0,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];

function exampleScreenshot() {
  return {
    sha256: "cdb30873bdf16770bfea1fe86e44db7476e504c2dca1542b0660b20f47f523a7",
    bytes: 70,
    media_type: "image/png",
    data_base64:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  };
}
