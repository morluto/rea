import type { ProviderIdentity } from "./AnalysisProvider.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceObservation,
} from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
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
  BrowserCaptureComparison,
  BrowserCaptureComparisonInput,
} from "../domain/browserCaptureComparison.js";
import { commitBrowserScenarioNormalization } from "../domain/browserScenarioNormalization.js";
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
  | BrowserCaptureComparisonInput
  | CaptureWebScreenshotInput
  | CompareWebScreenshotsInput;
type BrowserEvidenceResult =
  | BrowserTargetList
  | WebPageInspection
  | WebBundleAnalysis
  | WebObservationSession
  | WebMcpDiscovery
  | BrowserCaptureComparison
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

/** Create Evidence for one request-scoped external browser observation. */
export const createBrowserEvidence = (
  operation: BrowserEvidenceOperation,
  input: BrowserEvidenceInput,
  result: BrowserEvidenceResult,
  provider: ProviderIdentity,
): Evidence =>
  createEvidence(undefined, provider, {
    predicateType: browserPredicate(operation),
    operation,
    parameters: browserParameters(input, result),
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
  result: BrowserEvidenceResult,
): EvidenceObservation["parameters"] => {
  if (!("cdp_endpoint" in input)) {
    if (
      "before_scenario" in input &&
      input.before_scenario !== undefined &&
      input.after_scenario !== undefined
    )
      return {
        comparison_kind: "browser_scenario",
        before_browser: input.before_scenario.browser,
        after_browser: input.after_scenario.browser,
        before_start_origin: input.before_scenario.scenario.start_origin,
        after_start_origin: input.after_scenario.scenario.start_origin,
        normalization_sha256: commitBrowserScenarioNormalization(
          input.normalization ?? { rules: [] },
        ).sha256,
      };
    if (
      input.before !== undefined &&
      input.after !== undefined &&
      "inspection" in input.before &&
      "inspection" in input.after
    )
      return {
        before_target_id: input.before.inspection.target.target_id,
        before_capture_ended_at:
          input.before.inspection.capture_window.ended_at,
        after_target_id: input.after.inspection.target.target_id,
        after_capture_ended_at: input.after.inspection.capture_window.ended_at,
      };
    if (isScreenshotComparison(input))
      return {
        before_artifact_sha256: input.before.sha256,
        after_artifact_sha256: input.after.sha256,
        channel_threshold: input.channel_threshold,
      };
    throw new Error("Browser comparison input did not match a comparison type");
  }
  const observedOrigin = browserResultTargetOrigin(result);
  const scope = {
    cdp_endpoint: input.cdp_endpoint,
    allowed_origins:
      input.allowed_origins.length > 0
        ? input.allowed_origins
        : "target_id" in input && observedOrigin !== undefined
          ? [observedOrigin]
          : [],
  };
  if (!("target_id" in input)) return scope;
  return {
    ...scope,
    target_id: input.target_id,
    ...("observation_ms" in input
      ? { observation_ms: input.observation_ms }
      : {}),
    ...("include_accessibility_text" in input
      ? {
          include_accessibility_text: input.include_accessibility_text,
          include_console_text: input.include_console_text,
          include_json_body_shapes: input.include_json_body_shapes,
          include_websocket_shapes: input.include_websocket_shapes,
          include_storage_keys: input.include_storage_keys,
          include_storage_fingerprints: input.include_storage_fingerprints,
          ...("include_script_sources" in input
            ? { include_script_sources: input.include_script_sources }
            : {}),
        }
      : {}),
    ...("fetch_source_maps" in input
      ? { fetch_source_maps: input.fetch_source_maps }
      : {}),
  };
};

const browserResultTargetOrigin = (
  result: BrowserEvidenceResult,
): string | undefined => {
  if (
    "inspection" in result &&
    typeof result.inspection === "object" &&
    result.inspection !== null &&
    "target" in result.inspection &&
    typeof result.inspection.target === "object" &&
    result.inspection.target !== null &&
    "origin" in result.inspection.target &&
    typeof result.inspection.target.origin === "string"
  )
    return result.inspection.target.origin;
  if (!("target" in result)) return undefined;
  if ("origin" in result.target) return result.target.origin;
  if ("initial_url" in result.target)
    return sanitizeBrowserUrl(result.target.initial_url).origin ?? undefined;
  return undefined;
};

const isScreenshotComparison = (
  input: BrowserEvidenceInput,
): input is CompareWebScreenshotsInput => "channel_threshold" in input;

const browserPredicate = (operation: BrowserEvidenceOperation): string => {
  switch (operation) {
    case "list_browser_targets":
      return "rea.browser-target-list";
    case "inspect_web_page":
      return "rea.web-page-inspection";
    case "analyze_web_bundle":
      return "rea.web-bundle-analysis";
    case "observe_web_session":
      return "rea.web-observation-session";
    case "discover_webmcp_tools":
      return "rea.webmcp-discovery";
    case "compare_web_captures":
      return "rea.web-capture-diff";
    case "capture_web_screenshot":
      return "rea.web-screenshot";
    case "compare_web_screenshots":
      return "rea.web-screenshot-diff";
  }
};
