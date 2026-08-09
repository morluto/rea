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
  schema_version: 1,
  browser: {
    mode: "connect",
    process_ownership: "external",
    cleanup: "disconnected-external",
    product: "Chromium",
    version: "149",
  },
  scenario: {
    start_origin: origin,
    allowed_origins: [origin],
    action_count: 1,
    secret_references: [],
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

/** Origin-scoped, passive browser reverse-engineering contracts. */
export const BROWSER_TOOL_CONTRACTS = [
  {
    name: "list_browser_targets",
    ...toolContractMetadata("list_browser_targets"),
    description:
      "List bounded page targets from an approved user-owned loopback Chrome DevTools Protocol endpoint. Only targets whose current URL matches an approved exact origin are returned; URL credentials, query values, and fragments are redacted.",
    kind: "browser-provider",
    inputSchema: listBrowserTargetsInputSchema,
    outputSchema: listOutputSchema,
    examples: [
      {
        title: "List approved browser page targets",
        input: {
          cdp_endpoint: endpoint,
          allowed_origins: [origin],
          approved: true,
          offset: 0,
          limit: 100,
        },
      },
    ],
  },
  {
    name: "inspect_web_page",
    ...toolContractMetadata("inspect_web_page"),
    description:
      "Passively inspect one approved page target through CDP without evaluating JavaScript, navigating, clicking, closing, or mutating the page. Returns bounded DOM structure, accessibility, scripts, resources, attach-window network and console metadata, workers, and redacted storage inventory as Evidence v2.",
    kind: "browser-provider",
    inputSchema: inspectWebPageInputSchema,
    outputSchema: inspectionOutputSchema,
    examples: [
      {
        title: "Inspect one approved browser page",
        input: {
          cdp_endpoint: endpoint,
          allowed_origins: [origin],
          approved: true,
          target_id: "TARGET_ID_FROM_LIST_BROWSER_TARGETS",
          observation_ms: 500,
          include_accessibility_text: false,
          include_console_text: false,
          console_text_approved: false,
          include_json_body_shapes: false,
          json_body_schema_approved: false,
          include_websocket_shapes: false,
          websocket_shape_approved: false,
          include_script_sources: false,
          include_storage_keys: false,
          include_storage_fingerprints: false,
          limits: {
            max_frames: 200,
            max_dom_nodes: 2_000,
            max_ax_nodes: 2_000,
            max_ax_text_field_bytes: 1_024,
            max_total_ax_text_bytes: 65_536,
            max_scripts: 200,
            max_resources: 2_000,
            max_workers: 500,
            max_storage_keys: 1_000,
            max_script_source_bytes: 1_048_576,
            max_total_script_source_bytes: 4_194_304,
            max_network_events: 1_000,
            max_console_events: 200,
            max_console_text_field_bytes: 1_024,
            max_total_console_text_bytes: 65_536,
            max_json_body_bytes: 1_048_576,
            max_total_json_body_bytes: 4_194_304,
            max_json_shape_nodes: 5_000,
            max_json_shape_depth: 20,
            max_websocket_events: 500,
            max_websocket_shape_bytes: 65_536,
            max_total_websocket_shape_bytes: 1_048_576,
          },
        },
      },
    ],
  },
  {
    name: "analyze_web_bundle",
    ...toolContractMetadata("analyze_web_bundle"),
    description:
      "Capture explicitly approved JavaScript source from one approved CDP page and statically derive a bounded chunk graph, route and endpoint candidates, vendor fingerprints, page-declared WebMCP metadata, and optional separately approved source-map evidence. JavaScript is parsed but never executed.",
    kind: "browser-provider",
    inputSchema: analyzeWebBundleInputSchema,
    outputSchema: bundleOutputSchema,
    examples: [
      {
        title: "Analyze an approved page bundle",
        input: {
          cdp_endpoint: endpoint,
          allowed_origins: [origin],
          approved: true,
          target_id: "TARGET_ID_FROM_LIST_BROWSER_TARGETS",
          observation_ms: 500,
          include_accessibility_text: false,
          include_script_sources: true,
          include_storage_keys: false,
          source_capture_approved: true,
          fetch_source_maps: false,
          source_map_fetch_approved: false,
          analysis_limits: {
            max_findings: 1_000,
            max_ast_nodes: 250_000,
            max_source_maps: 100,
            max_source_map_bytes: 4_194_304,
            max_total_source_map_bytes: 16_777_216,
            max_source_map_mappings: 10_000,
            max_original_sources: 2_000,
          },
        },
      },
    ],
  },
  {
    name: "observe_web_session",
    ...toolContractMetadata("observe_web_session"),
    description:
      "Arm a bounded CDP observation window while the user operates the page. Allows approved same-origin reload and SPA navigation, records ordered navigation, redirect, lifecycle, and failure metadata, and stops before retaining an out-of-policy destination.",
    kind: "browser-provider",
    inputSchema: observeWebSessionInputSchema,
    outputSchema: observationSessionOutputSchema,
    examples: [
      {
        title: "Observe one external user action",
        input: {
          cdp_endpoint: endpoint,
          allowed_origins: [origin],
          target_id: "TARGET_ID_FROM_LIST_BROWSER_TARGETS",
          approved: true,
          observation_ms: 10_000,
          max_timeline_events: 2_000,
        },
      },
    ],
  },
  {
    name: "discover_webmcp_tools",
    ...toolContractMetadata("discover_webmcp_tools"),
    description:
      "Passively inventory page-registered WebMCP tools using the experimental CDP WebMCP domain. Metadata is bounded and page-declared-untrusted; REA never registers or invokes discovered tools.",
    kind: "browser-provider",
    inputSchema: discoverWebMcpToolsInputSchema,
    outputSchema: webMcpOutputSchema,
    examples: [
      {
        title: "Discover current WebMCP declarations",
        input: {
          cdp_endpoint: endpoint,
          allowed_origins: [origin],
          target_id: "TARGET_ID_FROM_LIST_BROWSER_TARGETS",
          approved: true,
          observation_ms: 100,
          max_tools: 500,
          max_schema_bytes: 262_144,
          max_schema_nodes: 5_000,
          max_schema_depth: 20,
        },
      },
    ],
  },
  {
    name: "compare_web_captures",
    ...toolContractMetadata("compare_web_captures"),
    description:
      "Compare either passive web captures or step-indexed browser scenarios. Scenario comparison aligns exact step IDs, records deterministic literal normalization, and exposes bounded artifact-level changes plus alignment failures. Missing or truncated evidence never proves equality.",
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
          max_changes: 2_000,
        },
      },
    ],
  },
  {
    name: "capture_web_screenshot",
    ...toolContractMetadata("capture_web_screenshot"),
    description:
      "Capture the current visible viewport of one approved page as a bounded, content-addressed PNG artifact. Screenshot capture requires separate explicit approval and never scrolls, navigates, or evaluates page JavaScript.",
    kind: "browser-provider",
    inputSchema: captureWebScreenshotInputSchema,
    outputSchema: screenshotOutputSchema,
    examples: [
      {
        title: "Capture an approved viewport",
        input: {
          cdp_endpoint: endpoint,
          allowed_origins: [origin],
          target_id: "TARGET_ID_FROM_LIST_BROWSER_TARGETS",
          approved: true,
          screenshot_approved: true,
          maximum_image_bytes: 4_194_304,
        },
      },
    ],
  },
  {
    name: "compare_web_screenshots",
    ...toolContractMetadata("compare_web_screenshots"),
    description:
      "Compare two self-verifying PNG screenshot artifacts with bounded local pixel metrics. Returns exact changed-pixel ratios and channel deltas without OCR or external services.",
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
          maximum_pixels: 16_000_000,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];

function exampleScreenshot() {
  return {
    uri: "rea://web-screenshot/sha256/153cf6c9a526a63053a37b10234c2fd85df38887c2dc0a800d90abfa6631d01c",
    sha256: "153cf6c9a526a63053a37b10234c2fd85df38887c2dc0a800d90abfa6631d01c",
    bytes: 70,
    media_type: "image/png",
    data_base64:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==",
  };
}
