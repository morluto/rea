import { request } from "node:http";

import { z } from "zod";

import {
  AnalysisCancelledError,
  AnalysisError,
  AnalysisTimeoutError,
  BrowserObservationError,
  type BrowserObservationOperation,
} from "../domain/errors.js";

const HTTP_TIMEOUT_MS = 5_000;
const MAX_VERSION_BYTES = 64 * 1_024;
const MAX_TARGET_LIST_BYTES = 2 * 1_024 * 1_024;

const endpointVersionSchema = z.object({
  Browser: z.string().min(1).max(1_024),
  "Protocol-Version": z.string().min(1).max(100),
  "User-Agent": z.string().max(16_384),
  "V8-Version": z.string().max(1_024),
  "WebKit-Version": z.string().max(1_024),
  webSocketDebuggerUrl: z.string().min(1).max(2_048),
});

const endpointTargetSchema = z.object({
  id: z.string().min(1).max(256),
  type: z.string().min(1).max(100),
  title: z.string().max(16_384).default(""),
  url: z.string().max(65_536),
  attached: z.boolean().default(false),
  webSocketDebuggerUrl: z.string().min(1).max(2_048).optional(),
});
const endpointTargetsSchema = z.array(endpointTargetSchema).max(1_000);

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

/** Read bounded CDP discovery endpoints without following redirects. */
export const discoverCdpEndpoint = async (
  endpoint: string,
  operation: BrowserObservationOperation,
  signal?: AbortSignal,
): Promise<CdpEndpointDiscovery> => {
  const versionInput = await readJson(
    new URL("/json/version", endpoint),
    MAX_VERSION_BYTES,
    operation,
    signal,
  );
  const targetsInput = await readJson(
    new URL("/json/list", endpoint),
    MAX_TARGET_LIST_BYTES,
    operation,
    signal,
  );
  const version = parseEndpointValue(
    endpointVersionSchema,
    versionInput,
    operation,
  );
  const targets = parseEndpointValue(
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
      title: target.title,
      url: target.url,
      attached: target.attached,
      ...targetWebSocket(endpoint, target, operation),
    })),
  };
};

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

const parseEndpointValue = <Output>(
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
  const browserId = pathIdentifier(pathname, "/devtools/browser/", 1_024);
  if (browserId !== undefined) return { scope: "browser" };
  const targetId = pathIdentifier(pathname, "/devtools/page/", 256);
  return targetId === undefined ? undefined : { scope: "page", targetId };
};

const pathIdentifier = (
  pathname: string,
  prefix: string,
  maximumLength: number,
): string | undefined => {
  if (!pathname.startsWith(prefix)) return undefined;
  const identifier = pathname.slice(prefix.length);
  return identifier.length > 0 &&
    identifier.length <= maximumLength &&
    !identifier.includes("/")
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

const readJson = async (
  url: URL,
  maximumBytes: number,
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
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maximumBytes) {
            response.destroy(
              new BrowserObservationError(operation, "payload_limit"),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (cause: unknown) {
            reject(
              new BrowserObservationError(
                operation,
                "invalid_endpoint_response",
                { cause },
              ),
            );
          }
        });
        response.on("error", (cause: unknown) =>
          reject(endpointFailure(cause, operation, signal)),
        );
      },
    );
    request_.setTimeout(HTTP_TIMEOUT_MS, () =>
      request_.destroy(new AnalysisTimeoutError(operation, HTTP_TIMEOUT_MS)),
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
