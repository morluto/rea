import { createAndroidAnalysisProvider } from "../composition/android.js";
import type { AndroidAnalysisPort } from "../application/android/AndroidAnalysisPort.js";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";

import type { BinarySession } from "../application/binary/BinarySession.js";
import type { Logger } from "pino";
import { createServer } from "../server/createServer.js";
import type { ToolResultDelivery } from "../server/toolResult.js";
import type { RuntimeDependencies } from "./types.js";
import type { OptionalProviderLoadResult } from "../application/OptionalObservationProviders.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  MCP_CONNECTION_LOST,
  MCP_CONNECTION_START_FAILED,
} from "./messages.js";

interface ServerContext {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly delivery: ToolResultDelivery;
  readonly logger: Logger;
  readonly serverLogger: Logger;
  readonly loadOptionalProviders: () => Promise<OptionalProviderLoadResult>;
}

export const startMcpTransport = async (
  dependencies: RuntimeDependencies,
  session: BinarySession,
  serverContext: ServerContext,
): Promise<
  | {
      readonly ok: true;
      readonly handle: StdioServerHandle;
      readonly closeAndroid: () => Promise<void>;
    }
  | { readonly ok: false }
> => {
  const { serverLogger } = serverContext;
  let optionalProviders: OptionalProviderLoadResult = {};
  try {
    optionalProviders = await serverContext.loadOptionalProviders();
  } catch (cause: unknown) {
    serverLogger.warn(
      {
        error: cause instanceof Error ? cause.message : String(cause),
      },
      "Optional MCP providers could not load; affected tools remain unavailable",
    );
  }
  for (const failure of Object.values(
    optionalProviders.optionalProviderLoadFailures ?? {},
  )) {
    serverLogger.warn(
      { providerId: failure.providerId, error: failure.reason },
      "Optional MCP adapter could not load; its peers remain available",
    );
  }
  const androidProviders: AndroidAnalysisPort[] = [];
  const closeAndroid = async (): Promise<void> => {
    const results = await Promise.allSettled(
      androidProviders.map((provider) => provider.close()),
    );
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
  };
  let handle: StdioServerHandle;
  try {
    handle = dependencies.serve(
      () => {
        // The SDK can discard a discovery probe and construct a replacement server.
        const android = createAndroidAnalysisProvider(
          serverContext.environment,
        );
        androidProviders.push(android);
        return (dependencies.createServer ?? createServer)(
          { kind: "session", session },
          {
            logger: serverContext.logger,
            environment: serverContext.environment,
            delivery: serverContext.delivery,
            ...optionalProviders,
            androidAnalysis: android,
          },
        );
      },
      {
        onerror: () => {
          serverLogger.error(MCP_CONNECTION_LOST);
          dependencies.writeStderr(`${MCP_CONNECTION_LOST}\n`);
        },
      },
    );
  } catch (cause: unknown) {
    const [binaryCleanup, androidCleanup] = await Promise.allSettled([
      session.close(),
      closeAndroid(),
    ]);
    serverLogger.error(
      {
        error: cause instanceof Error ? cause.message : String(cause),
      },
      MCP_CONNECTION_START_FAILED,
    );
    dependencies.writeStderr(`${MCP_CONNECTION_START_FAILED}\n`);
    if (binaryCleanup.status === "fulfilled" && !binaryCleanup.value.ok) {
      const cleanupError = projectAnalysisError(binaryCleanup.value.error);
      serverLogger.error(
        { cleanup_error: cleanupError },
        "Binary provider cleanup failed after MCP startup",
      );
      dependencies.writeStderr(`${cleanupError.message}\n`);
    }
    for (const cleanup of [binaryCleanup, androidCleanup]) {
      if (cleanup.status === "rejected") {
        const reason =
          cleanup.reason instanceof Error
            ? cleanup.reason.message
            : String(cleanup.reason);
        serverLogger.error(
          { cleanup_error: reason },
          "Provider cleanup rejected after MCP startup",
        );
        dependencies.writeStderr(`Provider cleanup failed: ${reason}\n`);
      }
    }
    return { ok: false };
  }
  return { ok: true, handle, closeAndroid };
};
