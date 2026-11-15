import { isDeepStrictEqual } from "node:util";
import type { ProviderIdentity } from "./AnalysisProvider.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceObservation,
} from "../domain/evidence.js";
import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import type {
  InspectWebPageInput,
  ListBrowserTargetsInput,
} from "../domain/browserObservation.js";
import type {
  BrowserTargetList,
  WebPageInspection,
} from "../domain/browserObservationSchemas.js";
import type {
  AnalyzeWebBundleInput,
  WebBundleAcquisitionPartialObservation,
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
  CaptureWebScreenshotInput,
  WebScreenshot,
} from "../domain/webScreenshot.js";

import type { JsonValue } from "../domain/jsonValue.js";

/** The own JSON source and the facts admitted by its named output contract. */
export interface BrowserEvidenceReport {
  readonly source: JsonValue;
  readonly facts: BrowserEvidenceResult;
}

type BrowserEvidenceInput =
  | ListBrowserTargetsInput
  | InspectWebPageInput
  | AnalyzeWebBundleInput
  | ObserveWebSessionInput
  | DiscoverWebMcpToolsInput
  | CaptureWebScreenshotInput;
type BrowserEvidenceResult =
  | BrowserTargetList
  | WebPageInspection
  | WebBundleAnalysis
  | WebBundleAcquisitionPartialObservation
  | WebObservationSession
  | WebMcpDiscovery
  | WebScreenshot;
type BrowserEvidenceOperation =
  | "list_browser_targets"
  | "inspect_web_page"
  | "analyze_web_bundle"
  | "observe_web_session"
  | "discover_webmcp_tools"
  | "capture_web_screenshot";

const isBundleAcquisition = (
  result: BrowserEvidenceResult,
): result is WebBundleAcquisitionPartialObservation =>
  "kind" in result && result.kind === "web-bundle-acquisition";

/** Create Evidence for one request-scoped external browser observation. */
export const createBrowserEvidence = (
  operation: BrowserEvidenceOperation,
  input: BrowserEvidenceInput,
  report: BrowserEvidenceReport,
  provider: ProviderIdentity,
): Evidence => {
  const result = report.facts;
  const acquisition = isBundleAcquisition(result);
  const observed = acquisition ? result.inspection : result;
  return createEvidence(undefined, provider, {
    predicateType: browserPredicate(operation),
    operation,
    parameters: browserParameters(input, result),
    result,
    rawResult: isDeepStrictEqual(report.source, result) ? null : report.source,
    confidence: "observed",
    authority: "external-service",
    environment:
      "browser" in observed
        ? {
            id: `${observed.browser.product}@${observed.browser.revision}`,
            platform: "unknown",
            architecture: "unknown",
            isolation: "none",
          }
        : null,
    limitations: [
      ...observed.limitations,
      ...(acquisition && result.source_maps.limitation !== undefined
        ? [result.source_maps.limitation]
        : []),
      ...("browser" in observed
        ? ["Browser host platform and architecture were not observed."]
        : []),
    ],
  });
};

const browserParameters = (
  input: BrowserEvidenceInput,
  result: BrowserEvidenceResult,
): EvidenceObservation["parameters"] => {
  const observedOrigin = browserResultTargetOrigin(result);
  const scope = {
    cdp_endpoint: input.cdp_endpoint.recorded,
    allowed_origins:
      input.allowed_origins.length > 0
        ? input.allowed_origins
        : "target_id" in input && observedOrigin !== undefined
          ? [observedOrigin]
          : [],
    ...("discovery_timeout_ms" in input &&
    input.discovery_timeout_ms !== undefined
      ? { discovery_timeout_ms: input.discovery_timeout_ms }
      : {}),
    ...("command_timeout_ms" in input && input.command_timeout_ms !== undefined
      ? { command_timeout_ms: input.command_timeout_ms }
      : {}),
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
      ? {
          fetch_source_maps: input.fetch_source_maps,
          ...(input.source_map_limits === undefined
            ? {}
            : { source_map_limits: input.source_map_limits }),
          ...(input.semantic_precision === undefined
            ? {}
            : { semantic_precision: input.semantic_precision }),
          ...(input.max_heap_mb === undefined
            ? {}
            : { max_heap_mb: input.max_heap_mb }),
          ...(input.analysis_timeout_ms === undefined
            ? {}
            : { analysis_timeout_ms: input.analysis_timeout_ms }),
          ...(input.total_analysis_timeout_ms === undefined
            ? {}
            : { total_analysis_timeout_ms: input.total_analysis_timeout_ms }),
          ...(input.source_map_fetch_timeout_ms === undefined
            ? {}
            : {
                source_map_fetch_timeout_ms: input.source_map_fetch_timeout_ms,
              }),
        }
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
  if ("capture" in result && "target_origin" in result.capture)
    return result.capture.target_origin ?? undefined;
  if (!("target" in result)) return undefined;
  if ("origin" in result.target) return result.target.origin;
  if ("initial_url" in result.target)
    return sanitizeBrowserUrl(result.target.initial_url).origin ?? undefined;
  return undefined;
};

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
    case "capture_web_screenshot":
      return "rea.web-screenshot";
  }
};
