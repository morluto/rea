import { access, open } from "node:fs/promises";
import { join } from "node:path";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";

import { readWindowsPrivateRuntimeFile } from "../windows/WindowsPrivateRuntime.js";

import { err, ok, type Result } from "../domain/result.js";
import { GhidraSessionError } from "./GhidraSessionError.js";

/** Local bridge transports used by the current Ghidra session. */
export type GhidraTransportKind = "unix-socket" | "authenticated-loopback-tcp";

/** Private runtime coordinate used to discover one bridge listener. */
export interface GhidraEndpoint {
  readonly transport: GhidraTransportKind;
  readonly path: string;
}

/** Allocate an endpoint that fits the host's Unix sockaddr without moving the project. */
export const createGhidraEndpoint = async (
  runtimeRoot: string,
  transport: GhidraTransportKind,
  platform: NodeJS.Platform,
): Promise<{
  readonly endpoint: GhidraEndpoint;
  readonly socketRoot?: PrivateRuntimeRoot;
}> => {
  const path = join(
    runtimeRoot,
    transport === "unix-socket" ? "bridge.sock" : "bridge-endpoint.json",
  );
  // sockaddr_un includes a terminating NUL: macOS has 104 bytes, Linux 108.
  const maximumPathBytes = platform === "darwin" ? 103 : 107;
  if (
    transport !== "unix-socket" ||
    Buffer.byteLength(path, "utf8") <= maximumPathBytes
  )
    return { endpoint: { transport, path } };
  const socketRoot = await PrivateRuntimeRoot.create({
    parent: "/tmp",
    prefix: "rea-ghidra-socket-",
    platform,
  });
  return {
    endpoint: { transport, path: join(socketRoot.path, "s") },
    socketRoot,
  };
};

/** Exact Node connection target after endpoint discovery. */
export type GhidraConnectTarget =
  | { readonly path: string }
  | { readonly host: "127.0.0.1"; readonly port: number };

/** Observe a ready endpoint, returning null while its bridge is not listening. */
export const observeGhidraEndpoint = async (
  endpoint: GhidraEndpoint,
): Promise<Result<GhidraConnectTarget | null, GhidraSessionError>> => {
  if (endpoint.transport === "unix-socket") {
    try {
      await access(endpoint.path);
      return ok({ path: endpoint.path });
    } catch (cause: unknown) {
      return isMissing(cause)
        ? ok(null)
        : err(
            endpointFailure(
              endpoint,
              "Ghidra socket observation failed",
              cause,
            ),
          );
    }
  }
  if (process.platform === "win32") {
    try {
      return parseTcpEndpoint(
        endpoint,
        readWindowsPrivateRuntimeFile(endpoint.path),
      );
    } catch (cause: unknown) {
      return isMissing(cause) || isWindowsEndpointWriterBusy(cause)
        ? ok(null)
        : err(
            endpointFailure(
              endpoint,
              "Ghidra endpoint observation failed",
              cause,
            ),
          );
    }
  }
  let handle;
  try {
    handle = await open(endpoint.path, "r");
  } catch (cause: unknown) {
    return isMissing(cause)
      ? ok(null)
      : err(
          endpointFailure(
            endpoint,
            "Ghidra endpoint observation failed",
            cause,
          ),
        );
  }
  try {
    const encoded = await handle.readFile("utf8");
    if (encoded.length === 0)
      return err(endpointFailure(endpoint, "Ghidra TCP endpoint is invalid"));
    return parseTcpEndpoint(endpoint, encoded);
  } catch (cause: unknown) {
    return err(endpointFailure(endpoint, "Ghidra endpoint read failed", cause));
  } finally {
    await handle.close();
  }
};

const parseTcpEndpoint = (
  endpoint: GhidraEndpoint,
  encoded: string,
): Result<GhidraConnectTarget, GhidraSessionError> => {
  try {
    const value: unknown = JSON.parse(encoded);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !hasExactKeys(value, ["host", "port"]) ||
      value.host !== "127.0.0.1" ||
      !Number.isSafeInteger(value.port) ||
      typeof value.port !== "number" ||
      value.port < 1 ||
      value.port > 65_535
    )
      return err(endpointFailure(endpoint, "Ghidra TCP endpoint is invalid"));
    return ok({ host: "127.0.0.1", port: value.port });
  } catch (cause: unknown) {
    return err(
      endpointFailure(endpoint, "Ghidra TCP endpoint is invalid", cause),
    );
  }
};

const hasExactKeys = (
  value: object,
  expected: readonly string[],
): value is Record<string, unknown> => {
  const keys = Object.keys(value).sort((left, right) =>
    left.localeCompare(right),
  );
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
};

const endpointFailure = (
  endpoint: GhidraEndpoint,
  message: string,
  cause?: unknown,
): GhidraSessionError =>
  new GhidraSessionError(
    "start",
    message,
    {
      transport: endpoint.transport,
      endpoint_path: endpoint.path,
      ...(cause instanceof Error ? { error: cause.message } : {}),
    },
    cause instanceof Error ? { cause } : undefined,
  );

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const isWindowsEndpointWriterBusy = (cause: unknown): boolean =>
  cause instanceof Error && "win32Code" in cause && cause.win32Code === 32;
