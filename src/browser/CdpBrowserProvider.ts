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
import {
  AnalysisError,
  BrowserObservationError,
  ProviderAdapterError,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import { CdpConnection } from "./CdpConnection.js";
import {
  discoverCdpEndpoint,
  type CdpEndpointDiscovery,
  type CdpEndpointTarget,
} from "./CdpEndpoint.js";
import { capturePage } from "./CdpPageCapture.js";

const IDENTITY: ProviderIdentity = {
  id: "rea-cdp-browser",
  name: "REA Chrome DevTools Protocol observation provider",
  version: "1",
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
      const result = await capturePage({
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
      return ok(webPageInspectionSchema.parse(result));
    } catch (cause: unknown) {
      return err(providerError(cause, "inspect_web_page"));
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
  input: InspectWebPageInput,
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
  operation: "list_browser_targets" | "inspect_web_page",
): AnalysisError =>
  cause instanceof AnalysisError
    ? cause
    : new ProviderAdapterError(IDENTITY.id, operation, { cause });
