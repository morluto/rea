import type { BrowserObservationPort } from "../application/BrowserObservationPort.js";
import type { ProviderIdentity } from "../application/AnalysisProvider.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import {
  sanitizeBrowserUrl,
  type InspectWebPageInput,
  type ListBrowserTargetsInput,
} from "../domain/browserObservation.js";
import {
  browserTargetListSchema,
  webPageInspectionSchema,
  type BrowserTargetList,
  type WebPageInspection,
} from "../domain/browserObservationSchemas.js";
import { analyzeCapturedWebBundle } from "../domain/webBundleAnalyzer.js";
import {
  webBundleAnalysisSchema,
  type AnalyzeWebBundleInput,
  type WebBundleAnalysis,
} from "../domain/webBundleAnalysis.js";
import {
  webObservationSessionSchema,
  type ObserveWebSessionInput,
  type WebObservationSession,
} from "../domain/browserSession.js";
import {
  webMcpDiscoverySchema,
  type DiscoverWebMcpToolsInput,
  type WebMcpDiscovery,
} from "../domain/webMcpDiscovery.js";
import {
  browserCaptureComparisonSchema,
  compareBrowserCaptures,
  type BrowserCaptureComparison,
  type BrowserCaptureComparisonInput,
} from "../domain/browserCaptureComparison.js";
import {
  webScreenshotDiffSchema,
  webScreenshotSchema,
  type CaptureWebScreenshotInput,
  type CompareWebScreenshotsInput,
  type WebScreenshot,
  type WebScreenshotDiff,
} from "../domain/webScreenshot.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { type BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  discoverCdpEndpoint,
  hasCdpTargetWebSocket,
  type CdpEndpointDiscovery,
  type CdpEndpointTarget,
} from "./CdpEndpoint.js";
import {
  closeCdpTargetSession,
  openCdpTargetSession,
  type CdpTargetSession,
} from "./CdpTargetSession.js";
import { capturePage, type CapturedPage } from "./CdpPageCapture.js";
import { fetchWebSourceMaps } from "./WebSourceMapFetcher.js";
import { authorizeCdpTarget } from "./CdpAuthorizedTarget.js";
import { observeCdpSession } from "./CdpObservationSession.js";
import { discoverWebMcp } from "./CdpWebMcpDiscovery.js";
import { captureCdpScreenshot } from "./CdpScreenshot.js";
import { comparePngScreenshots } from "./PngVisualDiff.js";

import { CDP_BROWSER_PROVIDER_IDENTITY } from "./providerIdentities.js";
const CLEANUP_DOMAINS = ["Network", "Debugger", "Runtime", "Page"] as const;

/** Passive browser observation through a selected user-owned CDP endpoint. */
export class CdpBrowserProvider implements BrowserObservationPort {
  identity(): ProviderIdentity {
    return CDP_BROWSER_PROVIDER_IDENTITY;
  }

  async listTargets(
    input: ListBrowserTargetsInput,
    options: ExecutionOptions = {},
  ): Promise<Result<BrowserTargetList, AnalysisError>> {
    try {
      const discovery = await discoverCdpEndpoint(
        input.cdp_endpoint,
        "list_browser_targets",
        options.signal,
      );
      const selected = selectTargets(
        discovery,
        input.allowed_origins.length === 0
          ? undefined
          : new Set(input.allowed_origins),
      );
      return ok(
        browserTargetListSchema.parse({
          browser: discovery.version,
          targets: selected.allowed,
          excluded: selected.excluded,
          limitations: [
            input.allowed_origins.length === 0
              ? "All page targets with supported HTTP(S) URLs are listed."
              : "Only page targets whose current URL matches an explicitly requested exact origin are listed.",
            ...(selected.unconnectable === 0
              ? []
              : [
                  `${String(selected.unconnectable)} otherwise allowed page target(s) lacked a validated direct CDP WebSocket and were excluded.`,
                ]),
          ],
        }),
      );
    } catch (cause: unknown) {
      return err(providerError(cause, "list_browser_targets"));
    }
  }

  async inspectPage(
    input: InspectWebPageInput,
    options: ExecutionOptions = {},
  ): Promise<Result<WebPageInspection, AnalysisError>> {
    try {
      const captured = await this.#capture(input, options, "inspect_web_page");
      return ok(webPageInspectionSchema.parse(captured.inspection));
    } catch (cause: unknown) {
      return err(providerError(cause, "inspect_web_page"));
    }
  }

  async analyzeBundle(
    input: AnalyzeWebBundleInput,
    options: ExecutionOptions = {},
  ): Promise<Result<WebBundleAnalysis, AnalysisError>> {
    try {
      const captured = await this.#capture(
        input,
        options,
        "analyze_web_bundle",
      );
      const sourceMaps = input.fetch_source_maps
        ? await fetchWebSourceMaps(
            captured.sourceMapRequests,
            {
              ...input,
              allowed_origins:
                input.allowed_origins.length > 0
                  ? input.allowed_origins
                  : [captured.inspection.target.origin],
            },
            options.signal,
            { explicitAllowedOrigins: input.allowed_origins },
          )
        : undefined;
      return ok(
        webBundleAnalysisSchema.parse(
          analyzeCapturedWebBundle(captured.inspection, sourceMaps),
        ),
      );
    } catch (cause: unknown) {
      return err(providerError(cause, "analyze_web_bundle"));
    }
  }

  async observeSession(
    input: ObserveWebSessionInput,
    options: ExecutionOptions = {},
  ): Promise<Result<WebObservationSession, AnalysisError>> {
    let targetSession: CdpTargetSession | undefined;
    try {
      const discovery = await discoverCdpEndpoint(
        input.cdp_endpoint,
        "observe_web_session",
        options.signal,
      );
      const target = authorizeTarget(discovery, input);
      const scopedInput = scopeToTargetOrigin(input, target);
      targetSession = await openCdpTargetSession(
        discovery,
        target,
        "observe_web_session",
        options.signal,
      );
      return ok(
        webObservationSessionSchema.parse(
          await observeCdpSession({
            connection: targetSession.connection,
            sessionId: targetSession.sessionId,
            discovery,
            target,
            input: scopedInput,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.progress === undefined
              ? {}
              : { progress: options.progress }),
          }),
        ),
      );
    } catch (cause: unknown) {
      return err(providerError(cause, "observe_web_session"));
    } finally {
      if (targetSession !== undefined)
        await closeCdpTargetSession(
          targetSession,
          CLEANUP_DOMAINS,
          options.signal,
        );
    }
  }

  async discoverWebMcpTools(
    input: DiscoverWebMcpToolsInput,
    options: ExecutionOptions = {},
  ): Promise<Result<WebMcpDiscovery, AnalysisError>> {
    let targetSession: CdpTargetSession | undefined;
    try {
      const discovery = await discoverCdpEndpoint(
        input.cdp_endpoint,
        "discover_webmcp_tools",
        options.signal,
      );
      const target = authorizeTarget(discovery, input);
      const scopedInput = scopeToTargetOrigin(input, target);
      targetSession = await openCdpTargetSession(
        discovery,
        target,
        "discover_webmcp_tools",
        options.signal,
      );
      return ok(
        webMcpDiscoverySchema.parse(
          await discoverWebMcp({
            connection: targetSession.connection,
            sessionId: targetSession.sessionId,
            discovery,
            target,
            input: scopedInput,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.progress === undefined
              ? {}
              : { progress: options.progress }),
          }),
        ),
      );
    } catch (cause: unknown) {
      return err(providerError(cause, "discover_webmcp_tools"));
    } finally {
      if (targetSession !== undefined)
        await closeCdpTargetSession(
          targetSession,
          CLEANUP_DOMAINS,
          options.signal,
        );
    }
  }

  async compareCaptures(
    input: BrowserCaptureComparisonInput,
  ): Promise<Result<BrowserCaptureComparison, AnalysisError>> {
    try {
      return ok(
        browserCaptureComparisonSchema.parse(compareBrowserCaptures(input)),
      );
    } catch (cause: unknown) {
      return err(providerError(cause, "compare_web_captures"));
    }
  }

  async captureScreenshot(
    input: CaptureWebScreenshotInput,
    options: ExecutionOptions = {},
  ): Promise<Result<WebScreenshot, AnalysisError>> {
    let targetSession: CdpTargetSession | undefined;
    try {
      const discovery = await discoverCdpEndpoint(
        input.cdp_endpoint,
        "capture_web_screenshot",
        options.signal,
      );
      const target = authorizeTarget(discovery, input);
      const scopedInput = scopeToTargetOrigin(input, target);
      targetSession = await openCdpTargetSession(
        discovery,
        target,
        "capture_web_screenshot",
        options.signal,
      );
      return ok(
        webScreenshotSchema.parse(
          await captureCdpScreenshot({
            connection: targetSession.connection,
            sessionId: targetSession.sessionId,
            discovery,
            target,
            input: scopedInput,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.progress === undefined
              ? {}
              : { progress: options.progress }),
          }),
        ),
      );
    } catch (cause: unknown) {
      return err(providerError(cause, "capture_web_screenshot"));
    } finally {
      if (targetSession !== undefined)
        await closeCdpTargetSession(
          targetSession,
          CLEANUP_DOMAINS,
          options.signal,
        );
    }
  }

  async compareScreenshots(
    input: CompareWebScreenshotsInput,
  ): Promise<Result<WebScreenshotDiff, AnalysisError>> {
    try {
      return ok(webScreenshotDiffSchema.parse(comparePngScreenshots(input)));
    } catch (cause: unknown) {
      return err(providerError(cause, "compare_web_screenshots"));
    }
  }

  async #capture(
    input: InspectWebPageInput,
    options: ExecutionOptions,
    operation: "inspect_web_page" | "analyze_web_bundle",
  ): Promise<CapturedPage> {
    let targetSession: CdpTargetSession | undefined;
    try {
      const discovery = await discoverCdpEndpoint(
        input.cdp_endpoint,
        operation,
        options.signal,
      );
      const target = authorizeTarget(discovery, input);
      const scopedInput = scopeToTargetOrigin(input, target);
      targetSession = await openCdpTargetSession(
        discovery,
        target,
        operation,
        options.signal,
      );
      return await capturePage({
        connection: targetSession.connection,
        sessionId: targetSession.sessionId,
        operation,
        discovery,
        target,
        input: scopedInput,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.progress === undefined
          ? {}
          : { progress: options.progress }),
      });
    } finally {
      if (targetSession !== undefined)
        await closeCdpTargetSession(
          targetSession,
          CLEANUP_DOMAINS,
          options.signal,
        );
    }
  }
}

const selectTargets = (
  discovery: CdpEndpointDiscovery,
  allowedOrigins: ReadonlySet<string> | undefined,
): {
  readonly allowed: readonly BrowserTargetList["targets"][number][];
  readonly excluded: BrowserTargetList["excluded"];
  readonly unconnectable: number;
} => {
  const allowed = [];
  let disallowedOrigin = 0;
  let unsupportedUrl = 0;
  let nonPage = 0;
  let unconnectable = 0;
  for (const target of discovery.targets) {
    if (target.type !== "page") {
      nonPage += 1;
      continue;
    }
    const url = sanitizeBrowserUrl(target.url);
    if (url.origin === null) {
      unsupportedUrl += 1;
      continue;
    }
    if (allowedOrigins !== undefined && !allowedOrigins.has(url.origin)) {
      disallowedOrigin += 1;
      continue;
    }
    if (!hasCdpTargetWebSocket(discovery, target)) {
      unconnectable += 1;
      continue;
    }
    allowed.push({
      target_id: target.id,
      type: target.type,
      title: target.title,
      url: url.url,
      origin: url.origin,
      attached: target.attached,
    });
  }
  allowed.sort((left, right) => left.target_id.localeCompare(right.target_id));
  return {
    allowed,
    excluded: {
      disallowed_origin: disallowedOrigin,
      unsupported_url: unsupportedUrl,
      non_page: nonPage,
    },
    unconnectable,
  };
};

const authorizeTarget = (
  discovery: CdpEndpointDiscovery,
  input: Pick<InspectWebPageInput, "target_id" | "allowed_origins">,
): CdpEndpointTarget => {
  return authorizeCdpTarget(discovery, input, "inspect_web_page").target;
};

const scopeToTargetOrigin = <T extends { allowed_origins: readonly string[] }>(
  input: T,
  target: CdpEndpointTarget,
): T => {
  if (input.allowed_origins.length > 0) return input;
  const origin = sanitizeBrowserUrl(target.url).origin;
  if (origin === null)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  return { ...input, allowed_origins: [origin] };
};

const providerError = (
  cause: unknown,
  operation: BrowserObservationOperation,
): AnalysisError =>
  cause instanceof BrowserObservationError && cause.operation !== operation
    ? new BrowserObservationError(operation, cause.reason, { cause })
    : cause instanceof AnalysisError
      ? cause
      : new ProviderAdapterError(CDP_BROWSER_PROVIDER_IDENTITY.id, operation, {
          cause,
        });
