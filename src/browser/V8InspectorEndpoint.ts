import { z } from "zod";

import type {
  JavaScriptRuntimeTargetList,
  JavaScriptRuntimeTargetLocation,
} from "../domain/javascriptRuntimeObservation.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { type BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import { parseCdpEndpointValue, readCdpJson } from "./CdpEndpoint.js";

const versionSchema = z
  .object({
    Browser: z.string().min(1),
    "Protocol-Version": z.string().min(1),
    "V8-Version": z.string().optional(),
  })
  .passthrough();

const targetSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    url: z.string(),
    attached: z.boolean().default(false),
    webSocketDebuggerUrl: z.string().min(1),
  })
  .passthrough();
const targetsSchema = z.array(targetSchema);

export interface V8InspectorTarget {
  readonly id: string;
  readonly type: string;
  readonly url: string;
  readonly attached: boolean;
  readonly webSocketUrl: string;
}

export interface V8InspectorDiscovery {
  readonly runtime: JavaScriptRuntimeTargetList["runtime"];
  readonly targets: readonly V8InspectorTarget[];
}

/** Discover Node/Electron Inspector targets from one loopback endpoint. */
export const discoverV8Inspector = async (
  endpoint: string,
  operation: BrowserObservationOperation,
  signal?: AbortSignal,
): Promise<V8InspectorDiscovery> => {
  const [versionInput, targetsInput] = await Promise.all([
    readCdpJson(new URL("/json/version", endpoint), operation, signal),
    readCdpJson(new URL("/json/list", endpoint), operation, signal),
  ]);
  const version = parseCdpEndpointValue(versionSchema, versionInput, operation);
  const targets = parseCdpEndpointValue(targetsSchema, targetsInput, operation);
  return {
    runtime: {
      product: version.Browser,
      protocol_version: version["Protocol-Version"],
      v8_version: version["V8-Version"] ?? null,
    },
    targets: targets.map((target) => ({
      id: target.id,
      type: target.type,
      url: target.url,
      attached: target.attached,
      webSocketUrl: validatedInspectorWebSocket(
        endpoint,
        target.id,
        target.webSocketDebuggerUrl,
        operation,
      ),
    })),
  };
};

const validatedInspectorWebSocket = (
  endpoint: string,
  targetId: string,
  reported: string,
  operation: BrowserObservationOperation,
): string => {
  let socket: URL;
  try {
    socket = new URL(reported);
  } catch (cause: unknown) {
    throw new BrowserObservationError(operation, "invalid_endpoint_response", {
      cause,
    });
  }
  const trusted = new URL(endpoint);
  const allowedPaths = new Set([
    `/${targetId}`,
    `/devtools/node/${targetId}`,
    `/devtools/page/${targetId}`,
  ]);
  if (
    socket.protocol !== "ws:" ||
    socket.port !== trusted.port ||
    socket.username !== "" ||
    socket.password !== "" ||
    socket.search !== "" ||
    socket.hash !== "" ||
    !allowedPaths.has(socket.pathname)
  )
    throw new BrowserObservationError(operation, "invalid_endpoint_response");
  socket.hostname = trusted.hostname;
  return socket.href;
};

/** Authorized target plus its durable location. */
export interface AuthorizedV8InspectorTarget extends V8InspectorTarget {
  readonly location: JavaScriptRuntimeTargetLocation;
}
