import type { ToolContract } from "./toolContracts.js";
import {
  browserTargetListSchema,
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
  webPageInspectionSchema,
} from "../domain/browserObservation.js";
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
import {
  browserCaptureComparisonInputSchema,
  browserCaptureComparisonSchema,
} from "../domain/browserCaptureComparison.js";
import {
  captureWebScreenshotInputSchema,
  compareWebScreenshotsInputSchema,
  webScreenshotDiffSchema,
  webScreenshotSchema,
} from "../domain/webScreenshot.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemas.js";

const evidenceResult = evidenceResultOf;
const listOutputSchema = evidenceResult(browserTargetListSchema);
const inspectionOutputSchema = evidenceResult(webPageInspectionSchema);
const bundleOutputSchema = evidenceResult(webBundleAnalysisSchema);
const observationSessionOutputSchema = evidenceResult(
  webObservationSessionSchema,
);
const webMcpOutputSchema = evidenceResult(webMcpDiscoverySchema);
const captureDiffOutputSchema = evidenceResult(browserCaptureComparisonSchema);
const screenshotOutputSchema = evidenceResult(webScreenshotSchema);
const screenshotDiffOutputSchema = evidenceResult(webScreenshotDiffSchema);

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
  events: { retained: 0, dropped: 0, items: [] },
  completeness: scenarioCompleteness,
  limitations: [],
});

/** Passive browser reverse-engineering contracts. */
export const BROWSER_TOOL_CONTRACTS = [
  {
    name: "list_browser_targets",
    ...toolContractMetadata("list_browser_targets"),
    description:
      "List page targets exposed by the selected loopback Chrome DevTools Protocol endpoint. Optionally filter by exact origin. URLs preserve query values and fragments; only URL userinfo credentials are removed.",
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
      "Capture JavaScript source from one selected CDP page and statically derive a chunk graph, route and endpoint candidates, vendor fingerprints, page-declared WebMCP metadata, and optionally fetch source maps from the selected target origin or explicitly requested origins. JavaScript is parsed but never executed.",
    kind: "browser-provider",
    inputSchema: analyzeWebBundleInputSchema,
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
      "Compare passive web captures by providing before and after, each with the complete inspect_web_page normalized_result in inspection and an optional complete discover_webmcp_tools normalized_result in webmcp; or compare recorded scenarios by passing complete capture_browser_scenario normalized_result objects in before_scenario and after_scenario with an optional normalization policy. Use exactly one input group. Scenario comparison aligns exact step IDs, records deterministic literal normalization, and returns every artifact-level difference plus alignment failures inline. Missing or truncated evidence never proves equality.",
    kind: "browser-provider",
    inputSchema: browserCaptureComparisonInputSchema,
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
      "Compare two self-verifying PNG screenshot artifacts with local pixel metrics. Returns exact changed-pixel ratios and channel deltas without OCR or external services.",
    kind: "browser-provider",
    inputSchema: compareWebScreenshotsInputSchema,
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
    sha256: "153cf6c9a526a63053a37b10234c2fd85df38887c2dc0a800d90abfa6631d01c",
    bytes: 70,
    media_type: "image/png",
    data_base64:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==",
  };
}
