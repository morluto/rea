import type { BrowserObservationPort } from "../application/BrowserObservationPort.js";
import type { ProviderIdentity } from "../application/AnalysisProvider.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import {
  browserTargetListSchema,
  sanitizeBrowserUrl,
  webPageInspectionSchema,
  type BrowserTargetList,
  type InspectWebPageInput,
  type ListBrowserTargetsInput,
  type WebPageInspection,
} from "../domain/browserObservation.js";
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
  compareWebCaptures,
  webCaptureDiffSchema,
  type CompareWebCapturesInput,
  type WebCaptureDiff,
} from "../domain/webCaptureDiff.js";
import {
  webScreenshotDiffSchema,
  webScreenshotSchema,
  type CaptureWebScreenshotInput,
  type CompareWebScreenshotsInput,
  type WebScreenshot,
  type WebScreenshotDiff,
} from "../domain/webScreenshot.js";
import {
  AnalysisError,
  BrowserObservationError,
  ProviderAdapterError,
  type BrowserObservationOperation,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import { CdpConnection } from "./CdpConnection.js";
import {
  discoverCdpEndpoint,
  type CdpEndpointDiscovery,
  type CdpEndpointTarget,
} from "./CdpEndpoint.js";
import { capturePage, type CapturedPage } from "./CdpPageCapture.js";
import { fetchWebSourceMaps } from "./WebSourceMapFetcher.js";
import { observeCdpSession } from "./CdpObservationSession.js";
import { discoverWebMcp } from "./CdpWebMcpDiscovery.js";
import { captureCdpScreenshot } from "./CdpScreenshot.js";
import { comparePngScreenshots } from "./PngVisualDiff.js";

const IDENTITY: ProviderIdentity = {
  id: "rea-cdp-browser",
  name: "REA Chrome DevTools Protocol observation provider",
  version: "2",
};

/** Passive, origin-scoped browser observation through a user-owned CDP endpoint. */
export class CdpBrowserProvider implements BrowserObservationPort {
  identity(): ProviderIdentity {
    return IDENTITY;
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
      const allowedOrigins = new Set(input.allowed_origins);
      const selected = selectTargets(discovery, allowedOrigins);
      const items = selected.allowed.slice(
        input.offset,
        input.offset + input.limit,
      );
      const nextOffset = input.offset + items.length;
      return ok(
        browserTargetListSchema.parse({
          schema_version: 1,
          browser: discovery.version,
          targets: {
            items,
            offset: input.offset,
            limit: input.limit,
            total: selected.allowed.length,
            next_offset:
              nextOffset < selected.allowed.length ? nextOffset : null,
            has_more: nextOffset < selected.allowed.length,
          },
          excluded: selected.excluded,
          limitations: [
            "Only page targets whose current URL matches an approved exact origin are listed.",
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
      const captured = await this.#capture(input, options);
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
      const captured = await this.#capture(input, options);
      const sourceMaps = input.fetch_source_maps
        ? await fetchWebSourceMaps(
            captured.sourceMapRequests,
            input,
            options.signal,
          )
        : undefined;
      return ok(
        webBundleAnalysisSchema.parse(
          analyzeCapturedWebBundle(captured.inspection, input, sourceMaps),
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
    let connection: CdpConnection | undefined;
    let sessionId: string | undefined;
    try {
      const discovery = await discoverCdpEndpoint(
        input.cdp_endpoint,
        "inspect_web_page",
        options.signal,
      );
      const target = authorizeTarget(discovery, input);
      connection = await CdpConnection.connect(
        discovery.browserWebSocketUrl,
        options.signal,
      );
      const attached = await connection.send(
        "Target.attachToTarget",
        { targetId: target.id, flatten: true },
        undefined,
        options.signal,
      );
      sessionId = attachedSessionId(attached);
      return ok(
        webObservationSessionSchema.parse(
          await observeCdpSession({
            connection,
            sessionId,
            discovery,
            target,
            input,
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
      if (connection !== undefined) {
        if (sessionId !== undefined)
          await bestEffortCleanup(connection, sessionId);
        await connection.close();
      }
    }
  }

  async discoverWebMcpTools(
    input: DiscoverWebMcpToolsInput,
    options: ExecutionOptions = {},
  ): Promise<Result<WebMcpDiscovery, AnalysisError>> {
    let connection: CdpConnection | undefined;
    let sessionId: string | undefined;
    try {
      const discovery = await discoverCdpEndpoint(
        input.cdp_endpoint,
        "inspect_web_page",
        options.signal,
      );
      const target = authorizeTarget(discovery, input);
      connection = await CdpConnection.connect(
        discovery.browserWebSocketUrl,
        options.signal,
      );
      const attached = await connection.send(
        "Target.attachToTarget",
        { targetId: target.id, flatten: true },
        undefined,
        options.signal,
      );
      sessionId = attachedSessionId(attached);
      return ok(
        webMcpDiscoverySchema.parse(
          await discoverWebMcp({
            connection,
            sessionId,
            discovery,
            target,
            input,
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
      if (connection !== undefined) {
        if (sessionId !== undefined)
          await bestEffortCleanup(connection, sessionId);
        await connection.close();
      }
    }
  }

  async compareCaptures(
    input: CompareWebCapturesInput,
  ): Promise<Result<WebCaptureDiff, AnalysisError>> {
    try {
      return ok(webCaptureDiffSchema.parse(compareWebCaptures(input)));
    } catch (cause: unknown) {
      return err(providerError(cause, "compare_web_captures"));
    }
  }

  async captureScreenshot(
    input: CaptureWebScreenshotInput,
    options: ExecutionOptions = {},
  ): Promise<Result<WebScreenshot, AnalysisError>> {
    let connection: CdpConnection | undefined;
    let sessionId: string | undefined;
    try {
      const discovery = await discoverCdpEndpoint(
        input.cdp_endpoint,
        "inspect_web_page",
        options.signal,
      );
      const target = authorizeTarget(discovery, input);
      connection = await CdpConnection.connect(
        discovery.browserWebSocketUrl,
        options.signal,
      );
      const attached = await connection.send(
        "Target.attachToTarget",
        { targetId: target.id, flatten: true },
        undefined,
        options.signal,
      );
      sessionId = attachedSessionId(attached);
      return ok(
        webScreenshotSchema.parse(
          await captureCdpScreenshot({
            connection,
            sessionId,
            discovery,
            target,
            input,
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
      if (connection !== undefined) {
        if (sessionId !== undefined)
          await bestEffortCleanup(connection, sessionId);
        await connection.close();
      }
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
  ): Promise<CapturedPage> {
    let connection: CdpConnection | undefined;
    let sessionId: string | undefined;
    try {
      const discovery = await discoverCdpEndpoint(
        input.cdp_endpoint,
        "inspect_web_page",
        options.signal,
      );
      const target = authorizeTarget(discovery, input);
      connection = await CdpConnection.connect(
        discovery.browserWebSocketUrl,
        options.signal,
      );
      const attached = await connection.send(
        "Target.attachToTarget",
        { targetId: target.id, flatten: true },
        undefined,
        options.signal,
      );
      sessionId = attachedSessionId(attached);
      return await capturePage({
        connection,
        sessionId,
        discovery,
        target,
        input,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.progress === undefined
          ? {}
          : { progress: options.progress }),
      });
    } finally {
      if (connection !== undefined) {
        if (sessionId !== undefined)
          await bestEffortCleanup(connection, sessionId);
        await connection.close();
      }
    }
  }
}

const selectTargets = (
  discovery: CdpEndpointDiscovery,
  allowedOrigins: ReadonlySet<string>,
): {
  readonly allowed: readonly BrowserTargetList["targets"]["items"][number][];
  readonly excluded: BrowserTargetList["excluded"];
} => {
  const allowed = [];
  let disallowedOrigin = 0;
  let unsupportedUrl = 0;
  let nonPage = 0;
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
    if (!allowedOrigins.has(url.origin)) {
      disallowedOrigin += 1;
      continue;
    }
    allowed.push({
      target_id: target.id,
      type: target.type,
      title: target.title.slice(0, 16_384),
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
  };
};

const authorizeTarget = (
  discovery: CdpEndpointDiscovery,
  input: Pick<InspectWebPageInput, "target_id" | "allowed_origins">,
): CdpEndpointTarget => {
  const target = discovery.targets.find(
    (candidate) => candidate.id === input.target_id,
  );
  if (target === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_not_found");
  const origin = sanitizeBrowserUrl(target.url).origin;
  if (
    target.type !== "page" ||
    origin === null ||
    !input.allowed_origins.includes(origin)
  )
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  return target;
};

const attachedSessionId = (value: unknown): string => {
  if (typeof value !== "object" || value === null || !("sessionId" in value))
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  if (typeof value.sessionId !== "string" || value.sessionId.length > 256)
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  return value.sessionId;
};

const bestEffortCleanup = async (
  connection: CdpConnection,
  sessionId: string,
): Promise<void> => {
  for (const method of [
    "Network.disable",
    "Debugger.disable",
    "Runtime.disable",
    "Page.disable",
  ]) {
    try {
      await connection.send(method, {}, sessionId);
    } catch {
      // Cleanup continues so detach is still attempted.
    }
  }
  try {
    await connection.send("Target.detachFromTarget", { sessionId });
  } catch {
    // Closing REA's socket is the final non-destructive cleanup boundary.
  }
};

const providerError = (
  cause: unknown,
  operation: BrowserObservationOperation,
): AnalysisError =>
  cause instanceof BrowserObservationError && cause.operation !== operation
    ? new BrowserObservationError(operation, cause.reason, { cause })
    : cause instanceof AnalysisError
      ? cause
      : new ProviderAdapterError(IDENTITY.id, operation, { cause });
