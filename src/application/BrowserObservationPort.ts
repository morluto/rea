import type { AnalysisError } from "../domain/errors.js";
import type {
  BrowserTargetList,
  InspectWebPageInput,
  ListBrowserTargetsInput,
  WebPageInspection,
} from "../domain/browserObservation.js";
import type { Result } from "../domain/result.js";
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
import type { ProviderIdentity } from "./AnalysisProvider.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";

/** Provider-neutral application boundary for passive browser observation. */
export interface BrowserObservationPort {
  identity(): ProviderIdentity;
  listTargets(
    input: ListBrowserTargetsInput,
    options?: ExecutionOptions,
  ): Promise<Result<BrowserTargetList, AnalysisError>>;
  inspectPage(
    input: InspectWebPageInput,
    options?: ExecutionOptions,
  ): Promise<Result<WebPageInspection, AnalysisError>>;
  analyzeBundle(
    input: AnalyzeWebBundleInput,
    options?: ExecutionOptions,
  ): Promise<Result<WebBundleAnalysis, AnalysisError>>;
  observeSession(
    input: ObserveWebSessionInput,
    options?: ExecutionOptions,
  ): Promise<Result<WebObservationSession, AnalysisError>>;
  discoverWebMcpTools(
    input: DiscoverWebMcpToolsInput,
    options?: ExecutionOptions,
  ): Promise<Result<WebMcpDiscovery, AnalysisError>>;
  compareCaptures(
    input: CompareWebCapturesInput,
  ): Promise<Result<WebCaptureDiff, AnalysisError>>;
  captureScreenshot(
    input: CaptureWebScreenshotInput,
    options?: ExecutionOptions,
  ): Promise<Result<WebScreenshot, AnalysisError>>;
  compareScreenshots(
    input: CompareWebScreenshotsInput,
  ): Promise<Result<WebScreenshotDiff, AnalysisError>>;
}
