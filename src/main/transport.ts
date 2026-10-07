import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";

import type { BinarySession } from "../application/BinarySession.js";
import type { Logger } from "../logger.js";
import { createServer } from "../server/createServer.js";
import type { RuntimeDependencies } from "./types.js";
import type { OptionalProviderLoadResult } from "../application/OptionalObservationProviders.js";
import {
  MCP_CONNECTION_LOST,
  MCP_CONNECTION_START_FAILED,
} from "./messages.js";

/** Optional adapters whose absence must not prevent the core MCP server. */
export type OptionalProviders = OptionalProviderLoadResult;

interface ServerContext {
  readonly logger: Logger;
  readonly serverLogger: Logger;
  readonly loadOptionalProviders: () => Promise<OptionalProviders>;
}

export const startMcpTransport = async (
  dependencies: RuntimeDependencies,
  session: BinarySession,
  serverContext: ServerContext,
): Promise<
  | {
      readonly ok: true;
      readonly handle: StdioServerHandle;
    }
  | { readonly ok: false }
> => {
  const { serverLogger } = serverContext;
  let optionalProviders: OptionalProviders = {};
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
  let handle: StdioServerHandle;
  try {
    handle = dependencies.serve(
      () =>
        (dependencies.createServer ?? createServer)(session, session, {
          logger: serverContext.logger,
          ...optionalProviders,
        }),
      {
        onerror: () => {
          serverLogger.error(MCP_CONNECTION_LOST);
          dependencies.writeStderr(`${MCP_CONNECTION_LOST}\n`);
        },
      },
    );
  } catch (cause: unknown) {
    await session.close();
    serverLogger.error(
      {
        error: cause instanceof Error ? cause.message : String(cause),
      },
      MCP_CONNECTION_START_FAILED,
    );
    dependencies.writeStderr(`${MCP_CONNECTION_START_FAILED}\n`);
    return { ok: false };
  }
  return { ok: true, handle };
};
