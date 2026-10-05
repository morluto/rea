import { request } from "node:http";

import { z } from "zod";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { type BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import { safeParseJson } from "../domain/safeJson.js";

const endpointVersionSchema = z.object({
  Browser: z.string().min(1),
  "Protocol-Version": z.string().min(1),
  "User-Agent": z.string(),
  "V8-Version": z.string(),
  "WebKit-Version": z.string(),
  webSocketDebuggerUrl: z.string().min(1),
});

const endpointTargetSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  title: z.string().default(""),
  url: z.string(),
  attached: z.boolean().default(false),
  webSocketDebuggerUrl: z.string().min(1).optional(),
});
const endpointTargetsSchema = z.array(endpointTargetSchema);

/** Validated direct CDP WebSocket bound to one discovered page target. */
interface CdpPageWebSocketEndpoint {
  readonly scope: "page";
  readonly targetId: string;
  readonly url: string;
}

/** Validated CDP discovery socket and its command-routing scope. */
export type CdpWebSocketEndpoint =
  | { readonly scope: "browser"; readonly url: string }
  | CdpPageWebSocketEndpoint;

/** Bounded discovery target with an optional validated direct transport. */
export interface CdpEndpointTarget {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
  readonly attached: boolean;
  readonly webSocket?: CdpPageWebSocketEndpoint;
}

export interface CdpEndpointDiscovery {
  readonly webSocket: CdpWebSocketEndpoint;
  readonly version: {
    readonly product: string;
    readonly protocol_version: string;
    readonly revision: string;
    readonly user_agent: string;
    readonly js_version: string;
  };
  readonly targets: readonly CdpEndpointTarget[];
}

/** Read CDP discovery endpoints without following redirects. */
export const discoverCdpEndpoint = async (
  endpoint: string,
  operation: BrowserObservationOperation,
  signal?: AbortSignal,
): Promise<CdpEndpointDiscovery> => {
  const versionInput = await readCdpJson(
    new URL("/json/version", endpoint),
    operation,
    signal,
  );
  const targetsInput = await readCdpJson(
    new URL("/json/list", endpoint),
    operation,
    signal,
  );
  const version = parseCdpEndpointValue(
    endpointVersionSchema,
    versionInput,
    operation,
  );
  const targets = parseCdpEndpointValue(
    endpointTargetsSchema,
    targetsInput,
    operation,
  );
  return {
    webSocket: safeCdpWebSocketEndpoint(
      endpoint,
      version.webSocketDebuggerUrl,
      operation,
    ),
    version: {
      product: version.Browser,
      protocol_version: version["Protocol-Version"],
      revision: version["WebKit-Version"],
      user_agent: version["User-Agent"],
      js_version: version["V8-Version"],
    },
    targets: targets.map((target) => ({
      id: target.id,
      type: target.type,
      title: sanitizeTargetTitle(target.title, target.url),
      url: target.url,
      attached: target.attached,
      ...targetWebSocket(endpoint, target, operation),
    })),
  };
};

const sanitizeTargetTitle = (value: string, targetUrl: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return sanitizeTargetUrlAlias(value, targetUrl);
  }
  return url.protocol === "http:" || url.protocol === "https:"
    ? sanitizeBrowserUrl(value).url
    : sanitizeTargetUrlAlias(value, targetUrl);
};

const sanitizeTargetUrlAlias = (value: string, targetUrl: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return value;
  }
  const markers = [parsed.origin, `//${parsed.host}`, parsed.host];
  if (parsed.pathname !== "/") markers.push(parsed.pathname);
  const candidatePattern = new RegExp(
    `(?:${markers.map(escapeRegExp).join("|")})[^\\s<>"']*`,
    "gu",
  );
  return value.replace(candidatePattern, (candidate) =>
    sanitizeSameOriginTitleUrl(candidate, parsed),
  );
};

const sanitizeSameOriginTitleUrl = (candidate: string, target: URL): string => {
  let parsed: URL;
  try {
    parsed = candidate.startsWith("//")
      ? new URL(`${target.protocol}${candidate}`)
      : candidate.startsWith(target.host)
        ? new URL(`${target.protocol}//${candidate}`)
        : new URL(candidate, target.origin);
  } catch {
    return candidate;
  }
  return parsed.origin === target.origin &&
    (parsed.username !== "" || parsed.password !== "")
    ? sanitizeBrowserUrl(candidate).url
    : candidate;
};

const escapeRegExp = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Select a browser attachment socket or a direct socket for one page target. */
export const cdpTargetWebSocket = (
  discovery: CdpEndpointDiscovery,
  target: CdpEndpointTarget,
  operation: BrowserObservationOperation,
): CdpWebSocketEndpoint => {
  const webSocket = availableCdpTargetWebSocket(discovery, target);
  if (webSocket !== undefined) return webSocket;
  throw new BrowserObservationError(operation, "invalid_endpoint_response");
};

/** Report whether discovery contains a validated transport for one target. */
export const hasCdpTargetWebSocket = (
  discovery: CdpEndpointDiscovery,
  target: CdpEndpointTarget,
): boolean => availableCdpTargetWebSocket(discovery, target) !== undefined;

const availableCdpTargetWebSocket = (
  discovery: CdpEndpointDiscovery,
  target: CdpEndpointTarget,
): CdpWebSocketEndpoint | undefined => {
  if (discovery.webSocket.scope === "browser") return discovery.webSocket;
  if (target.webSocket !== undefined) return target.webSocket;
  return discovery.webSocket.targetId === target.id
    ? discovery.webSocket
    : undefined;
};

/** Parse one CDP discovery value through its exact boundary schema. */
export const parseCdpEndpointValue = <Output>(
  schema: z.ZodType<Output>,
  input: unknown,
  operation: BrowserObservationOperation,
): Output => {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new BrowserObservationError(operation, "invalid_endpoint_response", {
      cause: parsed.error,
    });
  return parsed.data;
};

const safeCdpWebSocketEndpoint = (
  endpoint: string,
  reported: string,
  operation: BrowserObservationOperation,
): CdpWebSocketEndpoint => {
  let parsed: URL;
  try {
    parsed = new URL(reported);
  } catch (cause: unknown) {
    throw new BrowserObservationError(operation, "invalid_endpoint_response", {
      cause,
    });
  }
  const trustedEndpoint = new URL(endpoint);
  const path = cdpWebSocketPath(parsed.pathname);
  if (
    parsed.protocol !== "ws:" ||
    parsed.port !== trustedEndpoint.port ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    path === undefined
  )
    throw new BrowserObservationError(operation, "invalid_endpoint_response");
  parsed.hostname = trustedEndpoint.hostname;
  return path.scope === "browser"
    ? { scope: "browser", url: parsed.href }
    : { scope: "page", targetId: path.targetId, url: parsed.href };
};

const cdpWebSocketPath = (
  pathname: string,
):
  | { readonly scope: "browser" }
  | { readonly scope: "page"; targetId: string }
  | undefined => {
  const browserId = pathIdentifier(pathname, "/devtools/browser/");
  if (browserId !== undefined) return { scope: "browser" };
  const targetId = pathIdentifier(pathname, "/devtools/page/");
  return targetId === undefined ? undefined : { scope: "page", targetId };
};

const pathIdentifier = (
  pathname: string,
  prefix: string,
): string | undefined => {
  if (!pathname.startsWith(prefix)) return undefined;
  const identifier = pathname.slice(prefix.length);
  return identifier.length > 0 && !identifier.includes("/")
    ? identifier
    : undefined;
};

const targetWebSocket = (
  endpoint: string,
  target: z.infer<typeof endpointTargetSchema>,
  operation: BrowserObservationOperation,
): { readonly webSocket?: CdpPageWebSocketEndpoint } => {
  if (target.webSocketDebuggerUrl === undefined) return {};
  try {
    const webSocket = safeCdpWebSocketEndpoint(
      endpoint,
      target.webSocketDebuggerUrl,
      operation,
    );
    return webSocket.scope === "page" && webSocket.targetId === target.id
      ? { webSocket }
      : {};
  } catch {
    return {};
  }
};

/** Read one loopback CDP discovery document without redirects. */
export const readCdpJson = async (
  url: URL,
  operation: BrowserObservationOperation,
  signal?: AbortSignal,
): Promise<unknown> =>
  await new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new AnalysisCancelledError(operation));
      return;
    }
    const request_ = request(
      url,
      { method: "GET", signal, headers: { Accept: "application/json" } },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new BrowserObservationError(operation, "invalid_endpoint_response"),
          );
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const parsed = safeParseJson(Buffer.concat(chunks).toString("utf8"));
          if (!parsed.ok) {
            reject(
              new BrowserObservationError(
                operation,
                "invalid_endpoint_response",
                { cause: parsed.cause },
              ),
            );
            return;
          }
          resolve(parsed.value);
        });
        response.on("error", (cause: unknown) =>
          reject(endpointFailure(cause, operation, signal)),
        );
      },
    );
    request_.on("error", (cause: unknown) =>
      reject(endpointFailure(cause, operation, signal)),
    );
    request_.end();
  });

const endpointFailure = (
  cause: unknown,
  operation: BrowserObservationOperation,
  signal?: AbortSignal,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (signal?.aborted === true) return new AnalysisCancelledError(operation);
  return new BrowserObservationError(operation, "endpoint_unreachable", {
    cause,
  });
};
