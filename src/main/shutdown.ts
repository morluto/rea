import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";

import type { BinarySession } from "../application/BinarySession.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import type { Logger } from "../logger.js";
import type { RuntimeDependencies } from "./types.js";
import { MCP_SHUTDOWN_FAILED } from "./messages.js";

export const createShutdown = (input: {
  readonly handle: StdioServerHandle;
  readonly session: BinarySession;
  readonly permissionAuthority: PermissionAuthority;
  readonly unregisterReload: () => void;
  readonly dependencies: RuntimeDependencies;
  readonly serverLogger: Logger;
}): {
  readonly shutdown: () => Promise<void>;
  readonly request: () => void;
} => {
  const {
    handle,
    session,
    permissionAuthority,
    unregisterReload,
    dependencies,
    serverLogger,
  } = input;
  let shutdownPromise: Promise<void> | undefined;
  let unregisterShutdown = (): void => undefined;
  const shutdown = async (): Promise<void> => {
    shutdownPromise ??= (async () => {
      unregisterReload();
      unregisterShutdown();
      await handle.close();
      await session.close();
      permissionAuthority.clearSessionGrants();
    })();
    return shutdownPromise;
  };
  const requestShutdown = (): void => {
    shutdown().catch(() => {
      dependencies.setExitCode(1);
      serverLogger.error(MCP_SHUTDOWN_FAILED);
      dependencies.writeStderr(`${MCP_SHUTDOWN_FAILED}\n`);
    });
  };
  unregisterShutdown = dependencies.registerShutdown(requestShutdown);
  return { shutdown, request: requestShutdown };
};
