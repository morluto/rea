import { access, open } from "node:fs/promises";

import { err, ok, type Result } from "../domain/result.js";
import { GhidraSessionError } from "./GhidraSessionError.js";

/** Local bridge transports admitted by the versioned session descriptor. */
export type GhidraTransportKind = "unix-socket" | "authenticated-loopback-tcp";

/** Private runtime coordinate used to discover one bridge listener. */
export interface GhidraEndpoint {
  readonly transport: GhidraTransportKind;
  readonly path: string;
}

/** Exact Node connection target after endpoint discovery. */
export type GhidraConnectTarget =
  | { readonly path: string }
  | { readonly host: "127.0.0.1"; readonly port: number };

const MAX_ENDPOINT_BYTES = 1024;

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
    const bytes = Buffer.alloc(MAX_ENDPOINT_BYTES + 1);
    const observed = await handle.read(bytes, 0, bytes.length, 0);
    if (observed.bytesRead === 0 || observed.bytesRead > MAX_ENDPOINT_BYTES)
      return err(endpointFailure(endpoint, "Ghidra TCP endpoint is invalid"));
    return parseTcpEndpoint(
      endpoint,
      bytes.subarray(0, observed.bytesRead).toString("utf8"),
    );
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
      !hasExactKeys(value, ["host", "port", "schema_version"]) ||
      value.schema_version !== 1 ||
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
