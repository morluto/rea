import type { ToolContract } from "./toolContracts.js";
import { z } from "zod";
import { evidenceEnvelopeSchema } from "../domain/evidence.js";
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
  compareWebCapturesInputSchema,
  webCaptureDiffSchema,
} from "../domain/webCaptureDiff.js";
import {
  captureWebScreenshotInputSchema,
  compareWebScreenshotsInputSchema,
  webScreenshotDiffSchema,
  webScreenshotSchema,
} from "../domain/webScreenshot.js";

const evidenceResult = <Schema extends z.ZodType>(schema: Schema) =>
  evidenceEnvelopeSchema
    .omit({ normalized_result: true })
    .extend({ normalized_result: schema });
const listOutputSchema = evidenceResult(browserTargetListSchema);
const inspectionOutputSchema = evidenceEnvelopeSchema
  .omit({ normalized_result: true })
  .extend({ normalized_result: webPageInspectionSchema });
const bundleOutputSchema = evidenceEnvelopeSchema
  .omit({ normalized_result: true })
  .extend({ normalized_result: webBundleAnalysisSchema });
const observationSessionOutputSchema = evidenceEnvelopeSchema
  .omit({ normalized_result: true })
  .extend({ normalized_result: webObservationSessionSchema });
const webMcpOutputSchema = evidenceResult(webMcpDiscoverySchema);
const captureDiffOutputSchema = evidenceResult(webCaptureDiffSchema);
const screenshotOutputSchema = evidenceResult(webScreenshotSchema);
const screenshotDiffOutputSchema = evidenceResult(webScreenshotDiffSchema);

const endpoint = "http://127.0.0.1:9222";
const origin = "https://app.example.test";

/** Origin-scoped, passive browser reverse-engineering contracts. */
export const BROWSER_TOOL_CONTRACTS = [
  {
    name: "list_browser_targets",
    description:
      "List bounded page targets from an approved user-owned loopback Chrome DevTools Protocol endpoint. Only targets whose current URL matches an approved exact origin are returned; URL credentials, query values, and fragments are redacted.",
    kind: "browser-provider",
    inputSchema: listBrowserTargetsInputSchema,
    outputSchema: listOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
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
    description:
      "Passively inspect one approved page target through CDP without evaluating JavaScript, navigating, clicking, closing, or mutating the page. Returns bounded DOM structure, accessibility, scripts, resources, attach-window network and console metadata, workers, and redacted storage inventory as Evidence v2.",
    kind: "browser-provider",
    inputSchema: inspectWebPageInputSchema,
    outputSchema: inspectionOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
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
    description:
      "Capture explicitly approved JavaScript source from one approved CDP page and statically derive a bounded chunk graph, route and endpoint candidates, vendor fingerprints, page-declared WebMCP metadata, and optional separately approved source-map evidence. JavaScript is parsed but never executed.",
    kind: "browser-provider",
    inputSchema: analyzeWebBundleInputSchema,
    outputSchema: bundleOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
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
    description:
      "Arm a bounded CDP observation window while the user operates the page. Allows approved same-origin reload and SPA navigation, records ordered navigation, redirect, lifecycle, and failure metadata, and stops before retaining an out-of-policy destination.",
    kind: "browser-provider",
    inputSchema: observeWebSessionInputSchema,
    outputSchema: observationSessionOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
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
    description:
      "Passively inventory page-registered WebMCP tools using the experimental CDP WebMCP domain. Metadata is bounded and page-declared-untrusted; REA never registers or invokes discovered tools.",
    kind: "browser-provider",
    inputSchema: discoverWebMcpToolsInputSchema,
    outputSchema: webMcpOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
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
    description:
      "Compare two normalized web captures across DOM, scripts, resources, network, safe metadata, and optional WebMCP inventories. Stable observed changes are distinguished from unknown absence caused by incomplete capture coverage.",
    kind: "browser-provider",
    inputSchema: compareWebCapturesInputSchema,
    outputSchema: captureDiffOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    examples: [
      {
        title: "Compare two normalized captures",
        input: {
          before: { inspection: exampleInspection() },
          after: { inspection: exampleInspection() },
          max_changes: 2_000,
        },
      },
    ],
  },
  {
    name: "capture_web_screenshot",
    description:
      "Capture the current visible viewport of one approved page as a bounded, content-addressed PNG artifact. Screenshot capture requires separate explicit approval and never scrolls, navigates, or evaluates page JavaScript.",
    kind: "browser-provider",
    inputSchema: captureWebScreenshotInputSchema,
    outputSchema: screenshotOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
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
    description:
      "Compare two self-verifying PNG screenshot artifacts with bounded local pixel metrics. Returns exact changed-pixel ratios and channel deltas without OCR or external services.",
    kind: "browser-provider",
    inputSchema: compareWebScreenshotsInputSchema,
    outputSchema: screenshotDiffOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
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

function exampleCompleteness() {
  return {
    status: "complete_within_window",
    conditions: ["complete_within_window"],
    policy_filtered_sections: [],
    attach_limited_sections: [],
    truncated_sections: [],
    unavailable_sections: [],
    excluded: [],
    dropped_events: {
      scripts: 0,
      network_requests: 0,
      console_events: 0,
      websocket_connections: 0,
      websocket_frames: 0,
      webmcp_tools: 0,
      timeline_events: 0,
      total: 0,
    },
  };
}

function exampleInspection() {
  return {
    schema_version: 2,
    browser: {
      product: "Chrome/1",
      protocol_version: "1.3",
      revision: "example",
      user_agent: "Chrome",
      js_version: "1",
    },
    target: {
      target_id: "page-1",
      type: "page",
      title: "Example",
      url: `${origin}/`,
      origin,
      attached: false,
    },
    capture_window: {
      started_at: "2026-07-14T00:00:00.000Z",
      ended_at: "2026-07-14T00:00:01.000Z",
      observation_ms: 1_000,
    },
    completeness: exampleCompleteness(),
    frames: [],
    dom: { total_nodes: 0, nodes: [] },
    accessibility: {
      total_nodes: 0,
      text_capture: {
        status: "not_approved",
        retained_bytes: 0,
        excluded_fields: 0,
        truncated_fields: 0,
      },
      nodes: [],
    },
    scripts: { total: 0, items: [] },
    resources: [],
    network: {
      requests: [],
      websocket_events: [],
      coverage_started_at: "2026-07-14T00:00:00.000Z",
      prior_activity_available: false,
    },
    console: {
      events: [],
      coverage_started_at: "2026-07-14T00:00:00.000Z",
      prior_activity_available: false,
    },
    workers: [],
    metadata: {
      responses: [],
      dom_urls: [],
      agent_hints: [],
      excluded_dom_urls: 0,
      headers_allowlisted: true,
    },
    storage: {
      origin,
      usage_bytes: null,
      quota_bytes: null,
      local_storage_keys: [],
      session_storage_keys: [],
      indexed_db_names: [],
      cache_names: [],
      values_redacted: true,
    },
    limitations: [],
  };
}

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
