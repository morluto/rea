import type { Evidence } from "../domain/evidence.js";
import type {
  InspectWebPageInput,
  ListBrowserTargetsInput,
} from "../domain/browserObservation.js";
import type { AnalyzeWebBundleInput } from "../domain/webBundleAnalysis.js";
import type { ObserveWebSessionInput } from "../domain/browserSession.js";
import type { DiscoverWebMcpToolsInput } from "../domain/webMcpDiscovery.js";
import type { BrowserCaptureComparisonInput } from "../domain/browserCaptureComparison.js";
import type {
  CaptureWebScreenshotInput,
  CompareWebScreenshotsInput,
} from "../domain/webScreenshot.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { BrowserObservationPort } from "./BrowserObservationPort.js";
import { createBrowserEvidence } from "./BrowserEvidence.js";

/** List browser targets within the endpoint and origin scope in the request. */
export const listBrowserTargets = async (
  browser: BrowserObservationPort | undefined,
  input: ListBrowserTargetsInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireBrowser(browser, "list_browser_targets");
  if (!ready.ok) return ready;
  const result = await ready.value.listTargets(input, options);
  return result.ok
    ? ok(
        createBrowserEvidence(
          "list_browser_targets",
          input,
          result.value,
          ready.value.identity(),
        ),
      )
    : result;
};

/** Inspect one page within the endpoint and origin scope in the request. */
export const inspectWebPage = async (
  browser: BrowserObservationPort | undefined,
  input: InspectWebPageInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireBrowser(browser, "inspect_web_page");
  if (!ready.ok) return ready;
  const result = await ready.value.inspectPage(input, options);
  return result.ok
    ? ok(
        createBrowserEvidence(
          "inspect_web_page",
          input,
          result.value,
          ready.value.identity(),
        ),
      )
    : result;
};

/** Capture requested sources and derive static web-bundle evidence. */
export const analyzeWebBundle = async (
  browser: BrowserObservationPort | undefined,
  input: AnalyzeWebBundleInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireBrowser(browser, "analyze_web_bundle");
  if (!ready.ok) return ready;
  const analyzed = await ready.value.analyzeBundle(input, options);
  if (!analyzed.ok) return analyzed;
  return ok(
    createBrowserEvidence(
      "analyze_web_bundle",
      input,
      analyzed.value,
      ready.value.identity(),
    ),
  );
};

/** Observe navigation caused by external user actions during one armed window. */
export const observeWebSession = async (
  browser: BrowserObservationPort | undefined,
  input: ObserveWebSessionInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireBrowser(browser, "observe_web_session");
  if (!ready.ok) return ready;
  const observed = await ready.value.observeSession(input, options);
  return observed.ok
    ? ok(
        createBrowserEvidence(
          "observe_web_session",
          input,
          observed.value,
          ready.value.identity(),
        ),
      )
    : observed;
};

/** Discover WebMCP declarations without exposing an invocation surface. */
export const discoverWebMcpTools = async (
  browser: BrowserObservationPort | undefined,
  input: DiscoverWebMcpToolsInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireBrowser(browser, "discover_webmcp_tools");
  if (!ready.ok) return ready;
  const discovered = await ready.value.discoverWebMcpTools(input, options);
  return discovered.ok
    ? ok(
        createBrowserEvidence(
          "discover_webmcp_tools",
          input,
          discovered.value,
          ready.value.identity(),
        ),
      )
    : discovered;
};

/** Compare two already-normalized web captures without external access. */
export const compareWebCaptureEvidence = async (
  browser: BrowserObservationPort | undefined,
  input: BrowserCaptureComparisonInput,
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireBrowser(browser, "compare_web_captures");
  if (!ready.ok) return ready;
  const compared = await ready.value.compareCaptures(input);
  return compared.ok
    ? ok(
        createBrowserEvidence(
          "compare_web_captures",
          input,
          compared.value,
          ready.value.identity(),
        ),
      )
    : compared;
};

/** Capture one visible-viewport screenshot for the requested target. */
export const captureWebScreenshot = async (
  browser: BrowserObservationPort | undefined,
  input: CaptureWebScreenshotInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireBrowser(browser, "capture_web_screenshot");
  if (!ready.ok) return ready;
  const captured = await ready.value.captureScreenshot(input, options);
  return captured.ok
    ? ok(
        createBrowserEvidence(
          "capture_web_screenshot",
          input,
          captured.value,
          ready.value.identity(),
        ),
      )
    : captured;
};

/** Compare two self-verifying PNG artifacts without external access. */
export const compareWebScreenshotEvidence = async (
  browser: BrowserObservationPort | undefined,
  input: CompareWebScreenshotsInput,
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireBrowser(browser, "compare_web_screenshots");
  if (!ready.ok) return ready;
  const compared = await ready.value.compareScreenshots(input);
  return compared.ok
    ? ok(
        createBrowserEvidence(
          "compare_web_screenshots",
          input,
          compared.value,
          ready.value.identity(),
        ),
      )
    : compared;
};

const requireBrowser = (
  browser: BrowserObservationPort | undefined,
  operation: string,
): Result<BrowserObservationPort, AnalysisError> =>
  browser === undefined
    ? err(
        new AnalysisCapabilityUnavailableError(
          "rea-cdp-browser",
          operation,
          "browser observation provider is not configured",
        ),
      )
    : ok(browser);
