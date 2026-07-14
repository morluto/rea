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
});
const endpointTargetsSchema = z.array(endpointTargetSchema).max(1_000);

export type CdpEndpointTarget = z.infer<typeof endpointTargetSchema>;

export interface CdpEndpointDiscovery {
  readonly browserWebSocketUrl: string;
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
    browserWebSocketUrl: safeBrowserWebSocketUrl(
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
    targets,
  };
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

const safeBrowserWebSocketUrl = (
  endpoint: string,
  reported: string,
  operation: BrowserObservationOperation,
): string => {
  let parsed: URL;
  try {
    parsed = new URL(reported);
  } catch (cause: unknown) {
    throw new BrowserObservationError(operation, "invalid_endpoint_response", {
      cause,
    });
  }
  const trustedEndpoint = new URL(endpoint);
  if (
    parsed.protocol !== "ws:" ||
    parsed.port !== trustedEndpoint.port ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !parsed.pathname.startsWith("/devtools/browser/")
  )
    throw new BrowserObservationError(operation, "invalid_endpoint_response");
  parsed.hostname = trustedEndpoint.hostname;
  return parsed.href;
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
