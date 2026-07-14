import type { ProviderIdentity } from "./AnalysisProvider.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceObservation,
} from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type {
  BrowserTargetList,
  InspectWebPageInput,
  ListBrowserTargetsInput,
  WebPageInspection,
} from "../domain/browserObservation.js";
import type {
  AnalyzeWebBundleInput,
  WebBundleAnalysis,
} from "../domain/webBundleAnalysis.js";
import type {
  ObserveWebSessionInput,
  WebObservationSession,
} from "../domain/browserSession.js";
import type {
  DiscoverWebMcpToolsInput,
  WebMcpDiscovery,
} from "../domain/webMcpDiscovery.js";
import type {
  CompareWebCapturesInput,
  WebCaptureDiff,
} from "../domain/webCaptureDiff.js";
import type {
  CaptureWebScreenshotInput,
  CompareWebScreenshotsInput,
  WebScreenshot,
  WebScreenshotDiff,
} from "../domain/webScreenshot.js";

type BrowserEvidenceInput =
  | ListBrowserTargetsInput
  | InspectWebPageInput
  | AnalyzeWebBundleInput
  | ObserveWebSessionInput
  | DiscoverWebMcpToolsInput
  | CompareWebCapturesInput
  | CaptureWebScreenshotInput
  | CompareWebScreenshotsInput;
type BrowserEvidenceResult =
  | BrowserTargetList
  | WebPageInspection
  | WebBundleAnalysis
  | WebObservationSession
  | WebMcpDiscovery
  | WebCaptureDiff
  | WebScreenshot
  | WebScreenshotDiff;
type BrowserEvidenceOperation =
  | "list_browser_targets"
  | "inspect_web_page"
  | "analyze_web_bundle"
  | "observe_web_session"
  | "discover_webmcp_tools"
  | "compare_web_captures"
  | "capture_web_screenshot"
  | "compare_web_screenshots";

/** Create Evidence v2 for a policy-scoped external browser observation. */
export const createBrowserEvidence = (
  operation: BrowserEvidenceOperation,
  input: BrowserEvidenceInput,
  result: BrowserEvidenceResult,
  provider: ProviderIdentity,
): Evidence =>
  createEvidence(undefined, provider, {
    predicateType: browserPredicate(operation),
    operation,
    parameters: browserParameters(input),
    result: jsonValueSchema.parse(result),
    confidence: "observed",
    authority: "external-service",
    environment:
      "browser" in result
        ? {
            id: `${result.browser.product}@${result.browser.revision}`,
            platform: process.platform,
            architecture: process.arch,
            isolation: "none",
          }
        : null,
    limitations: result.limitations,
  });

const browserParameters = (
  input: BrowserEvidenceInput,
): EvidenceObservation["parameters"] => {
  if (!("cdp_endpoint" in input)) {
    if ("max_changes" in input)
      return {
        before_target_id: input.before.inspection.target.target_id,
        before_capture_ended_at:
          input.before.inspection.capture_window.ended_at,
        after_target_id: input.after.inspection.target.target_id,
        after_capture_ended_at: input.after.inspection.capture_window.ended_at,
        max_changes: input.max_changes,
      };
    return {
      before_artifact_uri: input.before.uri,
      after_artifact_uri: input.after.uri,
      channel_threshold: input.channel_threshold,
      maximum_pixels: input.maximum_pixels,
    };
  }
  const scope = {
    cdp_endpoint: input.cdp_endpoint,
    allowed_origins: input.allowed_origins,
  };
  if (!("target_id" in input))
    return { ...scope, offset: input.offset, limit: input.limit };
  if ("screenshot_approved" in input)
    return {
      ...scope,
      target_id: input.target_id,
      maximum_image_bytes: input.maximum_image_bytes,
    };
  if ("max_tools" in input)
    return {
      ...scope,
      target_id: input.target_id,
      observation_ms: input.observation_ms,
      max_tools: input.max_tools,
      max_schema_bytes: input.max_schema_bytes,
      max_schema_nodes: input.max_schema_nodes,
      max_schema_depth: input.max_schema_depth,
    };
  if (!("include_accessibility_text" in input))
    return {
      ...scope,
      target_id: input.target_id,
      observation_ms: input.observation_ms,
      max_timeline_events: input.max_timeline_events,
    };
  return {
    ...scope,
    target_id: input.target_id,
    observation_ms: input.observation_ms,
    include_accessibility_text: input.include_accessibility_text,
    include_console_text: input.include_console_text,
    include_json_body_shapes: input.include_json_body_shapes,
    include_websocket_shapes: input.include_websocket_shapes,
    include_script_sources: input.include_script_sources,
    include_storage_keys: input.include_storage_keys,
    limits: input.limits,
    ...(input.include_script_sources && "source_capture_approved" in input
      ? {
          source_capture_approved: input.source_capture_approved,
          fetch_source_maps: input.fetch_source_maps,
          source_map_fetch_approved: input.source_map_fetch_approved,
          analysis_limits: input.analysis_limits,
        }
      : {}),
  };
};

const browserPredicate = (operation: BrowserEvidenceOperation): string => {
  switch (operation) {
    case "list_browser_targets":
      return "rea.browser-target-list/v1";
    case "inspect_web_page":
      return "rea.web-page-inspection/v2";
    case "analyze_web_bundle":
      return "rea.web-bundle-analysis/v1";
    case "observe_web_session":
      return "rea.web-observation-session/v1";
    case "discover_webmcp_tools":
      return "rea.webmcp-discovery/v1";
    case "compare_web_captures":
      return "rea.web-capture-diff/v1";
    case "capture_web_screenshot":
      return "rea.web-screenshot/v1";
    case "compare_web_screenshots":
      return "rea.web-screenshot-diff/v1";
  }
};
