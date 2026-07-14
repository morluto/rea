import type { Evidence } from "../domain/evidence.js";
import type {
  InspectWebPageInput,
  ListBrowserTargetsInput,
} from "../domain/browserObservation.js";
import type { AnalyzeWebBundleInput } from "../domain/webBundleAnalysis.js";
import type { ObserveWebSessionInput } from "../domain/browserSession.js";
import type { DiscoverWebMcpToolsInput } from "../domain/webMcpDiscovery.js";
import type { CompareWebCapturesInput } from "../domain/webCaptureDiff.js";
import type {
  CaptureWebScreenshotInput,
  CompareWebScreenshotsInput,
} from "../domain/webScreenshot.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisProtocolError,
  PermissionRequiredError,
  type AnalysisError,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { BrowserObservationPort } from "./BrowserObservationPort.js";
import type { PermissionAuthority } from "./PermissionAuthority.js";
import { createBrowserEvidence } from "./BrowserEvidence.js";

type ScopedBrowserInput = Pick<
  ListBrowserTargetsInput,
  "cdp_endpoint" | "allowed_origins"
> & { readonly target_id?: string };

/** Authorize and execute one policy-scoped target discovery observation. */
export const listBrowserTargets = async (
  browser: BrowserObservationPort | undefined,
  authority: PermissionAuthority | undefined,
  input: ListBrowserTargetsInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = await prepare(
    browser,
    authority,
    input,
    "list_browser_targets",
  );
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

/** Authorize and execute one policy-scoped passive page inspection. */
export const inspectWebPage = async (
  browser: BrowserObservationPort | undefined,
  authority: PermissionAuthority | undefined,
  input: InspectWebPageInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = await prepare(browser, authority, input, "inspect_web_page");
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

/** Capture approved sources and derive bounded static web-bundle evidence. */
export const analyzeWebBundle = async (
  browser: BrowserObservationPort | undefined,
  authority: PermissionAuthority | undefined,
  input: AnalyzeWebBundleInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = await prepare(browser, authority, input, "analyze_web_bundle");
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
  authority: PermissionAuthority | undefined,
  input: ObserveWebSessionInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = await prepare(browser, authority, input, "observe_web_session");
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
  authority: PermissionAuthority | undefined,
  input: DiscoverWebMcpToolsInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = await prepare(
    browser,
    authority,
    input,
    "discover_webmcp_tools",
  );
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
  input: CompareWebCapturesInput,
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

/** Capture one explicitly approved visible-viewport screenshot. */
export const captureWebScreenshot = async (
  browser: BrowserObservationPort | undefined,
  authority: PermissionAuthority | undefined,
  input: CaptureWebScreenshotInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = await prepare(
    browser,
    authority,
    input,
    "capture_web_screenshot",
  );
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

const prepare = async (
  browser: BrowserObservationPort | undefined,
  authority: PermissionAuthority | undefined,
  input: ScopedBrowserInput,
  operation:
    | "list_browser_targets"
    | "inspect_web_page"
    | "analyze_web_bundle"
    | "observe_web_session"
    | "discover_webmcp_tools"
    | "capture_web_screenshot",
): Promise<Result<BrowserObservationPort, AnalysisError>> => {
  if (authority === undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        "rea-cdp-browser",
        operation,
        "browser observation permission policy is not configured",
      ),
    );
  const authorized = await authority.authorize(
    {
      capability: "browser_observe",
      roots: [],
      executables: [],
      environment_names: [],
      origins: [input.cdp_endpoint, ...input.allowed_origins],
      network: browserNetworkScope(input.allowed_origins),
      mount: false,
      operation_identity: `${operation}:${input.target_id ?? input.cdp_endpoint}`,
    },
    "read",
  );
  if (!authorized.ok)
    return err(
      authorized.error instanceof PermissionRequiredError
        ? authorized.error
        : new AnalysisProtocolError(authorized.error.message, {
            cause: authorized.error,
          }),
    );
  return browser === undefined
    ? err(
        new AnalysisCapabilityUnavailableError(
          "rea-cdp-browser",
          operation,
          "browser observation provider is not configured",
        ),
      )
    : ok(browser);
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
          "browser comparison provider is not configured",
        ),
      )
    : ok(browser);

const browserNetworkScope = (
  allowedOrigins: readonly string[],
): "loopback" | "external" =>
  allowedOrigins.every((origin) => {
    const hostname = new URL(origin).hostname;
    return hostname === "127.0.0.1" || hostname === "[::1]";
  })
    ? "loopback"
    : "external";
